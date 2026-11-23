/**
 * Times on the console are relative, because the Worker doesn't know the owner's time zone. The exact time,
 * in UTC, goes in a `title`.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"} ago`;

export function ago(at: number, now: number): string {
  const seconds = Math.max(0, now - at);
  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) return count(Math.floor(seconds / MINUTE), "minute");
  if (seconds < DAY) return count(Math.floor(seconds / HOUR), "hour");
  if (seconds < 2 * DAY) return "yesterday";
  return count(Math.floor(seconds / DAY), "day");
}

export function utc(at: number): string {
  return `${new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
