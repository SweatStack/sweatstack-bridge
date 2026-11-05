import type { Env } from "./config";

/** Everything the bridge takes from the outside world, so tests can replace all of it. */
export interface Deps {
  env: Env;
  fetch: typeof fetch;
  /** The current time in seconds since the epoch. */
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  /** Keeps the Worker alive for work that continues after the response. */
  waitUntil: (work: Promise<unknown>) => void;
}
