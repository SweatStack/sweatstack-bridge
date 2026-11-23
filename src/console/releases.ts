import type { Database } from "../db";
import type { Deps } from "../deps";
import { outbound } from "../http";

/** The newest release of the bridge, which the console compares with the running version. */

export const LATEST_RELEASE_URL = "https://api.github.com/repos/SweatStack/sweatstack-bridge/releases/latest";
const CACHE_KEY = "latest_release";
const CHECK_EVERY_SECONDS = 24 * 60 * 60;
const TIMEOUT_MS = 3_000;

/** What GitHub said, and when it was asked. `tag` is null when there's no release, absent when it didn't say. */
interface Cached {
  tag?: string | null;
  checkedAt: number;
}

/**
 * The newest release's tag: null when there's none, undefined when GitHub couldn't say. GitHub is asked at
 * most once a day, whatever it answers, so a page never waits on it twice and its rate limit is never near.
 */
export async function latestRelease(db: Database, deps: Pick<Deps, "fetch" | "now">): Promise<string | null | undefined> {
  const cached = parse(await db.metaValue(CACHE_KEY));
  if (cached !== null && deps.now() - cached.checkedAt < CHECK_EVERY_SECONDS) return cached.tag;

  const tag = await ask(deps);
  await db.setMeta(CACHE_KEY, JSON.stringify({ ...(tag === undefined ? {} : { tag }), checkedAt: deps.now() } satisfies Cached));
  return tag;
}

async function ask(deps: Pick<Deps, "fetch">): Promise<string | null | undefined> {
  try {
    const response = await outbound(deps, TIMEOUT_MS)(LATEST_RELEASE_URL, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "sweatstack-bridge" },
    });
    if (response.status === 404) return null;
    if (!response.ok) return undefined;
    const { tag_name: tag } = (await response.json()) as { tag_name?: unknown };
    return typeof tag === "string" && /^v\d+\.\d+\.\d+$/.test(tag) ? tag : undefined;
  } catch {
    return undefined;
  }
}

function parse(value: string | null): Cached | null {
  if (value === null) return null;
  try {
    const cached = JSON.parse(value) as Cached;
    return typeof cached.checkedAt === "number" ? cached : null;
  } catch {
    return null;
  }
}

/** Whether `latest` is a newer release than `version`, both as `major.minor.patch`. */
export function isNewer(latest: string, version: string): boolean {
  const parts = (value: string) => value.replace(/^v/, "").split(".").map(Number);
  const [a, b] = [parts(latest), parts(version)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}
