import { readConfig } from "../config";
import { Database } from "../db";
import type { Deps } from "../deps";
import { log } from "../log";
import { allProviders } from "../providers";
import { REFRESH_GRANT_WITHIN_SECONDS, UNCLAIMED_AFTER_SECONDS } from "./lifecycle";
import { drain } from "./worker";

/** Long enough for `npm run status` to show recent history. */
const KEEP_FINISHED_JOBS_SECONDS = 30 * 24 * 60 * 60;

/** After such a job gives up, how long before the sweeper adds another: a permanent refusal costs one try a day. */
const TRY_AGAIN_AFTER_SECONDS = 24 * 60 * 60;

/** The cron, every minute: what's due, then the housekeeping. A run with nothing to do writes nothing. */
export async function sweep(deps: Deps): Promise<void> {
  const db = new Database(deps.env.DB);
  try {
    await redeclareIfOffersChanged(deps, db);
    await enqueueWhatsDue(deps, db);
    await drain(deps);
    const now = deps.now();
    await db.purge(now, now - KEEP_FINISHED_JOBS_SECONDS);
  } catch (error) {
    log("sweep_failed", { error: error instanceof Error ? error.name : "unknown" });
  }
}

/** The work nothing else would start. Queued, so it gets the same retries and backoff as any other job. */
async function enqueueWhatsDue(deps: Deps, db: Database): Promise<void> {
  const now = deps.now();
  await db.enqueueDueRefreshes(now + REFRESH_GRANT_WITHIN_SECONDS, now, now - TRY_AGAIN_AFTER_SECONDS);
  await db.enqueueUnclaimed(now - UNCLAIMED_AFTER_SECONDS, now, now - TRY_AGAIN_AFTER_SECONDS);
}

/**
 * When the owner changes what their platform app offers, what every connection provides changes too, and
 * SweatStack only learns that by being told again. History that's newly on offer also has to be asked for.
 */
async function redeclareIfOffersChanged(deps: Deps, db: Database): Promise<void> {
  for (const provider of allProviders(deps)) {
    if (!readConfig(deps.env, provider).ok) continue;
    const offered = [...provider.offeredCapabilities()].sort().join(",");
    const key = `offered_capabilities:${provider.name}`;
    const declared = await db.metaValue(key);
    if (declared === offered) continue;
    await db.enqueueRecheckForAll(provider.name, deps.now());
    await db.setMeta(key, offered);
  }
}
