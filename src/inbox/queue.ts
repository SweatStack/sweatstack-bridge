import type { Database, JobRow } from "../db";

/** Long enough for any job to finish, so a lease only runs out when a Worker stopped mid-job. */
const LEASE_SECONDS = 5 * 60;

const FIRST_RETRY_SECONDS = 60;
const MAX_RETRY_SECONDS = 60 * 60;

/** Outlasts a real outage. A job still failing after this has stopped being a matter of time. */
const GIVE_UP_AFTER_SECONDS = 3 * 24 * 60 * 60;

/** What became of a job. A reason is a short constant, never a message: it's shown to the owner. */
export type JobResult = { outcome: "done" } | { outcome: "retry"; reason: string } | { outcome: "give_up"; reason: string };

export function claimNext(db: Database, now: number): Promise<JobRow | null> {
  return db.claimJob(now, now + LEASE_SECONDS);
}

export async function settle(db: Database, job: JobRow, result: JobResult, now: number): Promise<void> {
  if (result.outcome === "done") {
    await db.finishJob(job.id, now, null);
  } else if (result.outcome === "give_up" || now - job.received_at >= GIVE_UP_AFTER_SECONDS) {
    await db.finishJob(job.id, now, result.reason);
  } else {
    const delay = Math.min(FIRST_RETRY_SECONDS * 2 ** Math.max(job.attempts - 1, 0), MAX_RETRY_SECONDS);
    await db.retryJob(job.id, now + delay, result.reason);
  }
}
