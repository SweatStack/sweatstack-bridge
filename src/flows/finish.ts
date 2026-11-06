import { declare, type ConnectionServices } from "../connections";
import { drain } from "../inbox/worker";
import { log } from "../log";
import { SweatStackError } from "../sweatstack";

/** How often, and how many times, to ask for the user once the link is about to happen: about five seconds. */
const WAIT_INTERVAL_MS = 300;
const WAIT_ATTEMPTS = 16;

/** A `declare` job's first retry. Later ones back off from here. */
const RETRY_AFTER_SECONDS = 60;

/**
 * The call after the platform's consent. It never fails the sign-in: SweatStack makes the user itself
 * when the browser returns if this didn't work. A job sees to whatever's left, including a connection
 * still waiting for its user, so this holds even if the Worker stops right after.
 */
export async function declareAfterConsent(services: ConnectionServices, sub: string, platformUserId: string): Promise<void> {
  const { db, deps, provider } = services;
  const connection = await db.connection(sub);
  if (connection === null) return;

  let userId: string | null = null;
  try {
    userId = await declare(services, connection, platformUserId);
  } catch (error) {
    log("connection_call_failed", { provider: provider.name, status: error instanceof SweatStackError ? (error.status ?? null) : null });
  }
  const now = deps.now();
  if (userId === null) {
    await db.enqueue({ kind: "declare", provider: provider.name, sub, nextAttemptAt: now + RETRY_AFTER_SECONDS, receivedAt: now });
  } else {
    await db.wakeJobs(sub, now);
  }
  // Behind the redirect, so the browser never waits for it, and only after that call, because it can make
  // the user and this work may repeat it. This connection only: nobody's backlog stands in the way of the
  // first seconds.
  deps.waitUntil(drain(deps, { sub }));
}

/**
 * Repeats the call while the link is about to happen, so the first files don't wait for the next run of
 * the job above. Giving up here changes nothing: that job carries on.
 */
export async function waitForUser(services: ConnectionServices, sub: string): Promise<void> {
  const { db, deps, provider } = services;
  try {
    for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
      const connection = await db.connection(sub);
      if (connection === null || connection.user_id !== null) return;
      if ((await declare(services, connection)) !== null) {
        // Files may have arrived while it waited, and they shouldn't wait for the next run.
        await drain(deps, { sub });
        return;
      }
      await deps.sleep(WAIT_INTERVAL_MS);
    }
  } catch (error) {
    // Runs behind the response, so nothing else would report this.
    log("connection_call_failed", { provider: provider.name, status: error instanceof SweatStackError ? (error.status ?? null) : null });
  }
}
