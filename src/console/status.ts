import type { Facts } from "./facts";

/** The status's numbers, as a pure function of the facts. Counts only: never a subject or user. */
export interface Status {
  version: string;
  connected: number;
  needsReconnect: number;
  waitingForUser: number;
  lastFile: number | null;
  /** Undefined for an app that doesn't offer wellness, so the page doesn't mention it. */
  lastWellness: number | null | undefined;
  jobsWaiting: number;
  /** Jobs that gave up in the last 30 days. */
  failures: number;
}

export function status(facts: Facts): Status {
  const { activity, platform } = facts;
  const sum = (rows: readonly { count: number }[]) => rows.reduce((total, row) => total + row.count, 0);
  return {
    version: facts.version,
    connected: activity.connections.total,
    needsReconnect: activity.connections.needsReconnect,
    waitingForUser: activity.connections.waitingForUser,
    lastFile: activity.lastFile,
    lastWellness: platform.offers.has("wellness") ? activity.lastWellness : undefined,
    jobsWaiting: sum(activity.waiting),
    failures: sum(activity.failures),
  };
}
