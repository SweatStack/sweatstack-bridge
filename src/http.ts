import type { Deps } from "./deps";

/**
 * Every outbound call goes through here (rule 5): it has a timeout, and it follows no redirect, so a
 * credential can't be carried to a host nobody chose.
 */
export function outbound(deps: Pick<Deps, "fetch">, timeoutMs: number): typeof fetch {
  return (input, init) => deps.fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
}
