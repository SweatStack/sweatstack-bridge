import { declare, deregisterAtPlatform, keepGrantAlive, permissionsOf, withAccessToken, type ConnectionServices } from "../connections";
import type { ConnectionRow, JobRow } from "../db";
import { log } from "../log";
import { SweatStackError } from "../sweatstack";
import type { JobResult } from "./queue";

const DAY_SECONDS = 24 * 60 * 60;

/**
 * Right after a consent the platform can refuse for a moment. The first seconds decide the onboarding,
 * so those refusals are retried here, not left to the next run a minute away. Often at first, because any
 * time spent waiting after the platform is ready is time an athlete waits for nothing.
 */
const FIRST_RUN_WAITS_MS = [500, 500, 500, 500, 1_000, 1_500, 2_500];

/** Inside this much of its end, a quiet connection's grant is refreshed. */
export const REFRESH_GRANT_WITHIN_SECONDS = 30 * DAY_SECONDS;

/** How long a connection may wait for SweatStack to name its user. */
export const UNCLAIMED_AFTER_SECONDS = DAY_SECONDS;

/** Asks until the platform answers, briefly, and only on a job's first run. Null if it still hasn't. */
async function askUntilReady<T>(services: ConnectionServices, job: JobRow, ask: () => Promise<T | null>): Promise<T | null> {
  for (const wait of job.attempts === 1 ? FIRST_RUN_WAITS_MS : []) {
    const answer = await ask();
    if (answer !== null) return answer;
    await services.deps.sleep(wait);
  }
  return ask();
}

/** What was granted is the platform's to say, so a forged webhook can't set it and order doesn't matter. */
export async function permissionsJob(services: ConnectionServices, connection: ConnectionRow, job: JobRow): Promise<JobResult> {
  const { db, deps, provider } = services;
  const permissions = await askUntilReady(services, job, () => withAccessToken(services, connection, (token) => provider.fetchPermissions(token)));
  if (permissions === null) return { outcome: "retry", reason: "permissions_unknown" };
  await db.savePermissions(connection.sub, provider.name, permissions, { backfill: provider.mayBackfill(permissions) }, deps.now());
  return { outcome: "done" };
}

/** One stretch of history per run, with the place kept on the row, so any failure carries on from there. */
export async function backfillJob(services: ConnectionServices, connection: ConnectionRow, job: JobRow): Promise<JobResult> {
  const { config, db, deps, provider } = services;
  if (connection.backfill_done_at !== null || !provider.mayBackfill(permissionsOf(connection))) return { outcome: "done" };

  const progress = await askUntilReady(services, job, () =>
    withAccessToken(services, connection, (token) => provider.requestHistory(token, connection.backfill_cursor, config.backfillDays)),
  );
  if (progress === null) return { outcome: "retry", reason: "platform_not_ready" };

  if (progress.cursor !== null) {
    await db.saveBackfillCursor(connection.sub, progress.cursor);
    return { outcome: "continue" };
  }
  log("history_asked", { provider: provider.name, accepted: progress.anyAccepted });
  if (!progress.anyAccepted) {
    // Not marked, so a later consent or permission change asks again. SweatStack's 24 hours bound `syncing`.
    await db.saveBackfillCursor(connection.sub, null);
    return { outcome: "give_up", reason: "history_refused" };
  }
  await db.finishBackfill(connection.sub, provider.name, deps.now());
  return { outcome: "done" };
}

/**
 * The platform says it's over: the row, its jobs and then SweatStack's copy go. The message may be late, so
 * a consent newer than it stands. With no connection (the echo of a disconnect) this job doesn't run.
 */
export async function deregistrationJob(services: ConnectionServices, connection: ConnectionRow, job: JobRow): Promise<JobResult> {
  const { db, deps, provider } = services;
  await db.forgetDeregistered(connection.sub, provider.name, job.received_at, deps.now());
  return { outcome: "done" };
}

/** Rotating a refresh token nobody needs is a chance to lose it, so a job that's no longer due does nothing. */
export async function refreshGrantJob(services: ConnectionServices, connection: ConnectionRow): Promise<JobResult> {
  if (connection.needs_reconnect !== 0) return { outcome: "done" };
  await keepGrantAlive(services, connection, services.deps.now() + REFRESH_GRANT_WITHIN_SECONDS);
  return { outcome: "done" };
}

/**
 * A connection nobody claimed in a day: deregistered at the platform and deleted. This can't be
 * undone, so SweatStack is asked one last time first, and if it can't answer, the job waits. An outage
 * there must not cost an athlete their grant.
 */
export async function expireUnclaimedJob(services: ConnectionServices, connection: ConnectionRow): Promise<JobResult> {
  const { db, deps, provider } = services;
  const now = deps.now();
  if (connection.user_id !== null || connection.consented_at > now - UNCLAIMED_AFTER_SECONDS) return { outcome: "done" };

  if ((await lastAskForUser(services, connection)) !== null) return { outcome: "done" };

  await deregisterAtPlatform(services, connection);
  await db.forgetUnclaimed(connection.sub, provider.name, connection.consented_at, now);
  return { outcome: "done" };
}

/** Null also when SweatStack refuses the call, as when the card isn't self-hosted: then it's nobody's. */
async function lastAskForUser(services: ConnectionServices, connection: ConnectionRow): Promise<string | null> {
  try {
    return await declare(services, connection);
  } catch (error) {
    if (!(error instanceof SweatStackError) || error.status === undefined || error.status === 401 || error.status === 429 || error.status >= 500) throw error;
    return null;
  }
}
