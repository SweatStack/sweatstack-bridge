import { accessToken, declare, NeedsReconnect, RefreshInProgress, type ConnectionServices } from "../connections";
import { readConfig } from "../config";
import { Database, type ConnectionRow, type JobRow } from "../db";
import type { Deps } from "../deps";
import { log } from "../log";
import { findProvider } from "../providers";
import { PlatformError } from "../providers/types";
import { deleteConnection, SweatStackError, uploadActivityFile } from "../sweatstack";
import { claimNext, settle, type JobResult } from "./queue";

/** Generous for a small app, and it leaves room for the next minute's run. */
const MAX_JOBS_PER_RUN = 50;
const MAX_RUN_SECONDS = 25;

/**
 * Works through what's due. The live path calls this right after a webhook for speed, and the cron for
 * everything else. Two runs at once are fine, because a job is claimed by exactly one of them.
 */
export async function drain(deps: Deps): Promise<void> {
  const db = new Database(deps.env.DB);
  const startedAt = deps.now();
  try {
    for (let run = 0; run < MAX_JOBS_PER_RUN && deps.now() - startedAt < MAX_RUN_SECONDS; run += 1) {
      const job = await claimNext(db, deps.now());
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
      case "declare":
        return await declareJob(services, connection, job);
    }
  } catch (error) {
    return classify(error);
  }
}

async function relayFile(services: ConnectionServices, connection: ConnectionRow, job: JobRow): Promise<JobResult> {
  const { provider } = services;
  // A file is never uploaded before SweatStack has said whose it is.
  if (connection.user_id === null) return { outcome: "retry", reason: "waiting_for_user" };
  if (job.payload === null || job.external_id === null) return { outcome: "give_up", reason: "invalid_job" };
  if (!provider.mayRelayFiles(connection.permissions === null ? null : (JSON.parse(connection.permissions) as string[]))) {
    return { outcome: "done" };
  }

  const reference = JSON.parse(job.payload) as unknown;
  if (!provider.isDownloadAllowed(reference)) {
    log("file_refused", { provider: provider.name, reason: "foreign_host" });
    return { outcome: "give_up", reason: "foreign_download_host" };
  }

  let file;
  try {
    file = await provider.downloadFile(await accessToken(services, connection), reference);
  } catch (error) {
    if (!(error instanceof PlatformError) || error.status !== 401) throw error;
    file = await provider.downloadFile(await accessToken(services, connection, { force: true }), reference);
  }

  const outcome = await uploadActivityFile(services, {
    userId: connection.user_id,
    provider: provider.name,
    externalId: job.external_id,
    file,
  });
  return outcome.accepted ? { outcome: "done" } : { outcome: "give_up", reason: "file_refused_by_sweatstack" };
}

/** Sends the connection as it is now, so the order and number of these jobs doesn't matter. */
async function declareJob(services: ConnectionServices, connection: ConnectionRow | null, job: JobRow): Promise<JobResult> {
  if (connection === null) {
    await deleteConnection(services, services.provider.name, job.sub);
    return { outcome: "done" };
  }
  const userId = await declare(services, connection);
  return userId === null ? { outcome: "retry", reason: "waiting_for_user" } : { outcome: "done" };
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
    // Retrying can't help. 403: a user's token without `activities:write`, or the app's card isn't set
    // up. 404: the user is gone. 409: the platform isn't set to Self-hosted.
    return { outcome: "give_up", reason: `sweatstack_${status}` };
  }
  return { outcome: "retry", reason: error instanceof Error ? `error_${error.name}` : "error_unknown" };
}
