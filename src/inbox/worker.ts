import { declare, NeedsReconnect, permissionsOf, RefreshInProgress, withAccessToken, type ConnectionServices } from "../connections";
import { readConfig } from "../config";
import { Database, type ConnectionRow, type JobRow } from "../db";
import type { Deps } from "../deps";
import { log, warn } from "../log";
import { findProvider } from "../providers";
import { PlatformError, type DailyValue } from "../providers/types";
import { deleteConnection, SweatStackError, uploadActivityFile, writeDaily } from "../sweatstack";
import { backfillJob, deregistrationJob, expireUnclaimedJob, permissionsJob, refreshGrantJob, wellnessHistoryJob } from "./lifecycle";
import { claimNext, settle, type JobResult } from "./queue";

/** Generous for a small app, and it leaves room for the next minute's run. */
const MAX_JOBS_PER_RUN = 50;
const MAX_RUN_SECONDS = 25;

/**
 * Works through what's due. The live path calls this right after a webhook for speed, and the cron for
 * everything else. Two runs at once are fine, because a job is claimed by exactly one of them. With a
 * `sub`, only that connection's jobs.
 */
export async function drain(deps: Deps, { sub = null }: { sub?: string | null } = {}): Promise<void> {
  const db = new Database(deps.env.DB);
  const startedAt = deps.now();
  try {
    for (let run = 0; run < MAX_JOBS_PER_RUN && deps.now() - startedAt < MAX_RUN_SECONDS; run += 1) {
      const job = await claimNext(db, deps.now(), sub);
      if (job === null) return;
      const result = await runJob(deps, db, job);
      await settle(db, job, result, deps.now());
    }
  } catch (error) {
    // A job left unsettled comes back when its lease ends.
    log("drain_failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}

async function runJob(deps: Deps, db: Database, job: JobRow): Promise<JobResult> {
  const provider = findProvider(job.provider, deps);
  if (provider === undefined) return { outcome: "give_up", reason: "unknown_platform" };
  const configured = readConfig(deps.env, provider);
  if (!configured.ok) return { outcome: "retry", reason: "not_configured" };
  const services: ConnectionServices = { config: configured.config, db, deps, provider };

  try {
    const connection = await db.connection(job.sub);
    switch (job.kind) {
      case "activity_file":
        return connection === null ? { outcome: "done" } : await relayFile(services, connection, job);
      case "wellness":
        return connection === null ? { outcome: "done" } : await relayWellness(services, connection, job);
      case "declare":
        return await declareJob(services, connection, job);
      case "permissions_change":
        return connection === null ? { outcome: "done" } : await permissionsJob(services, connection, job);
      case "backfill":
        return connection === null ? { outcome: "done" } : await backfillJob(services, connection, job);
      case "wellness_history":
        return connection === null ? { outcome: "done" } : await wellnessHistoryJob(services, connection, job);
      case "deregistration":
        return connection === null ? { outcome: "done" } : await deregistrationJob(services, connection, job);
      case "refresh_grant":
        return connection === null ? { outcome: "done" } : await refreshGrantJob(services, connection);
      case "expire_unclaimed":
        return connection === null ? { outcome: "done" } : await expireUnclaimedJob(services, connection);
    }
  } catch (error) {
    return classify(error);
  }
}

async function relayFile(services: ConnectionServices, connection: ConnectionRow, job: JobRow): Promise<JobResult> {
  const { provider } = services;
  // A file is never uploaded before SweatStack has said whose it is.
  if (connection.user_id === null) return waitingForUser(services, job);
  if (job.payload === null || job.external_id === null) return { outcome: "give_up", reason: "invalid_job" };
  if (!provider.mayRelayFiles(permissionsOf(connection))) return { outcome: "done" };

  const reference = JSON.parse(job.payload) as unknown;
  if (!provider.isDownloadAllowed(reference)) {
    log("file_refused", { provider: provider.name, reason: "foreign_host" });
    return { outcome: "give_up", reason: "foreign_download_host" };
  }

  const file = await withAccessToken(services, connection, (token) => provider.downloadFile(token, reference));

  const outcome = await uploadActivityFile(services, {
    userId: connection.user_id,
    platform: provider.name,
    externalId: job.external_id,
    file,
  });
  return outcome.accepted ? { outcome: "done" } : { outcome: "give_up", reason: "file_refused_by_sweatstack" };
}

/**
 * A push for a connection that SweatStack hasn't named a user for. Said once, on the job's first run: the
 * athlete may still be on SweatStack's page, or nobody will ever claim it, as in a platform's partner
 * verification.
 */
function waitingForUser({ provider }: ConnectionServices, job: JobRow): JobResult {
  if (job.attempts === 1) warn("push_waiting_for_user", { provider: provider.name, kind: job.kind });
  return { outcome: "retry", reason: "waiting_for_user" };
}

/**
 * Writes the values a push brought, each replacing what its day held. A value SweatStack refuses, as one
 * outside its range, is skipped: the others still count. A retry writes them all again, which is safe.
 * The log says how many, never what.
 */
async function relayWellness(services: ConnectionServices, connection: ConnectionRow, job: JobRow): Promise<JobResult> {
  const { provider } = services;
  if (connection.user_id === null) return waitingForUser(services, job);
  if (job.payload === null) return { outcome: "give_up", reason: "invalid_job" };
  if (!provider.mayRelayWellness(permissionsOf(connection))) return { outcome: "done" };

  let written = 0;
  let refused = 0;
  for (const daily of JSON.parse(job.payload) as DailyValue[]) {
    const { accepted } = await writeDaily(services, { ...daily, userId: connection.user_id, platform: provider.name });
    if (accepted) written += 1;
    else {
      refused += 1;
      log("daily_refused", { provider: provider.name, measure: daily.measure });
    }
  }
  log("wellness_relayed", { provider: provider.name, written, refused });
  return { outcome: "done" };
}

/**
 * SweatStack doesn't say when it knows the user, and an athlete may be reading a page before it does. So at
 * first the bridge asks every minute, the most the cron allows, or their first files would wait for a backoff
 * that had nothing to do with them. After this long it's an abandoned tab, and the usual backoff is right.
 */
const ASK_EVERY_MINUTE_FOR_SECONDS = 60 * 60;

/** Sends the connection as it is now, so the order and number of these jobs doesn't matter. */
async function declareJob(services: ConnectionServices, connection: ConnectionRow | null, job: JobRow): Promise<JobResult> {
  if (connection === null) {
    await deleteConnection(services, services.provider.name, job.sub);
    return { outcome: "done" };
  }
  const userId = await declare(services, connection);
  // It may have ended while that call was under way, and SweatStack has to hear the end last.
  if ((await services.db.connection(job.sub)) === null) {
    await deleteConnection(services, services.provider.name, job.sub);
    return { outcome: "done" };
  }
  if (userId !== null) return { outcome: "done" };
  const justConsented = services.deps.now() - connection.consented_at < ASK_EVERY_MINUTE_FOR_SECONDS;
  return { outcome: "retry", reason: "waiting_for_user", ...(justConsented ? { afterSeconds: 60 } : {}) };
}

function classify(error: unknown): JobResult {
  if (error instanceof RefreshInProgress) return { outcome: "retry", reason: "refresh_in_progress" };
  if (error instanceof NeedsReconnect) return { outcome: "retry", reason: "needs_reconnect" };
  if (error instanceof PlatformError) {
    const { status } = error;
    if (status === undefined) return { outcome: "retry", reason: "platform_unreachable" };
    if (status === 429 || status >= 500 || status === 401) return { outcome: "retry", reason: `platform_${status}` };
    return { outcome: "give_up", reason: `platform_${status}` };
  }
  if (error instanceof SweatStackError) {
    const { status } = error;
    if (status === undefined) return { outcome: "retry", reason: "sweatstack_unreachable" };
    if (status === 429 || status >= 500 || status === 401) return { outcome: "retry", reason: `sweatstack_${status}` };
    // Retrying can't help. 400 on a user's token, or 403: the app doesn't have `activities:write` ticked,
    // or its card isn't set up. 404: the user is gone. 409: the platform isn't set to Self-hosted.
    return { outcome: "give_up", reason: `sweatstack_${status}` };
  }
  return { outcome: "retry", reason: error instanceof Error ? `error_${error.name}` : "error_unknown" };
}
