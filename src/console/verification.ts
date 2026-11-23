import { randomToken } from "../crypto";
import type { Database, WalkProgress } from "../db";
import type { Capability, VerificationGuide, VerificationStep } from "../providers/types";

/**
 * The verification walk: the platform's steps, one at a time, each moving on by itself once the bridge sees
 * its data. Where the owner is lives in `meta`, so a step that takes a night, or a closed tab, carries on there.
 * `advance` is a pure function of that place and what the bridge has seen.
 */

export const WALK_KEY = "verification";
/** A sign-in link works once, for an hour. */
const LINK_SECONDS = 60 * 60;

export interface Walk {
  step: string;
  /** When the current step began: only data from then on counts for it. */
  since: number;
  startedAt: number;
  /** The owner's time zone, for the calendar day a daily value is dated by. */
  timeZone: string;
  accounts: { a?: string; b?: string };
  /** When account A connected: the platform counts data for a window from then. */
  connectedAt?: number;
  /** The sign-in link under way. */
  flow?: { id: string; expiresAt: number };
  /** Said once, on the step it's about. */
  notice?: Notice;
  finishedAt?: number;
}

export type Notice = "refused" | "expired" | "same_account" | "connection_ended" | "skipped";

/** The steps this app takes: those for a capability only when the app offers it. */
export function walkSteps(guide: VerificationGuide, offers: ReadonlySet<Capability>): VerificationStep[] {
  return guide.steps.filter((step) => step.forCapability === undefined || offers.has(step.forCapability));
}

export function newWalk(steps: readonly VerificationStep[], now: number, timeZone: string): Walk {
  return { step: (steps[0] as VerificationStep).id, since: now, startedAt: now, timeZone: validTimeZone(timeZone), accounts: {} };
}

/** A time zone the runtime knows, or UTC. At worst, UTC makes a night's step wait for one more day. */
export function validTimeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** The calendar day in this time zone, as the platform dates a daily value: `YYYY-MM-DD`. */
export function calendarDay(seconds: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(seconds * 1000));
}

/** Moves the walk on through every step whose data has come, and notices what went wrong with a sign-in. */
export function advance(walk: Walk, steps: readonly VerificationStep[], progress: WalkProgress, now: number): Walk {
  if (walk.finishedAt !== undefined) return walk;
  const stepOf = (current: Walk) => steps.find((step) => step.id === current.step);

  // The bridge ends an account nobody claims a day after its sign-in, so a walk left too long starts again.
  // Only the tests can still pass then: the platform counts what it already received.
  const a = walk.accounts.a;
  if (a !== undefined && !progress.connected.has(a) && stepOf(walk)?.proof.kind !== "tests") {
    return { ...newWalk(steps, now, walk.timeZone), notice: "connection_ended" };
  }

  let next = walk;
  for (;;) {
    const step = stepOf(next);
    if (step === undefined) return next;
    const outcome = check(step, next, progress, now);
    if (outcome.changes !== undefined) next = { ...next, ...outcome.changes };
    if (!outcome.done) return next;
    next = moveOn(next, steps, now);
  }
}

/** The step after this one, begun now. */
export function moveOn(walk: Walk, steps: readonly VerificationStep[], now: number, notice?: Notice): Walk {
  const index = steps.findIndex((step) => step.id === walk.step);
  const following = steps[index + 1];
  const { notice: _, flow: __, ...rest } = walk;
  if (following === undefined) return { ...rest, finishedAt: now };
  return { ...rest, step: following.id, since: now, ...(notice === undefined ? {} : { notice }) };
}

/** Whether a step's data has come, and what the walk learned on the way. */
function check(step: VerificationStep, walk: Walk, progress: WalkProgress, now: number): { done: boolean; changes?: Partial<Walk> } {
  const account = step.account === undefined ? undefined : walk.accounts[step.account];
  const since = (kind: string) => progress.jobs.filter((job) => job.sub === account && job.kind === kind && job.at >= walk.since);
  const proof = step.proof;
  switch (proof.kind) {
    case "connected": {
      if (walk.flow === undefined || step.account === undefined) return { done: false };
      const gone = (notice: Notice) => ({ done: false, changes: { flow: undefined, notice } });
      if (progress.flow === null) return gone("refused");
      const sub = progress.flow.sub;
      if (sub === null) return walk.flow.expiresAt <= now ? gone("expired") : { done: false };
      if (sub === walk.accounts[step.account === "a" ? "b" : "a"]) return gone("same_account");
      return {
        done: true,
        changes: { accounts: { ...walk.accounts, [step.account]: sub }, ...(step.account === "a" ? { connectedAt: now } : {}) },
      };
    }
    case "job":
      return { done: since(proof.job).length > 0 };
    case "removed":
      return { done: account !== undefined && !progress.connected.has(account) };
    case "measured": {
      const fromDay = calendarDay(walk.since + proof.fromHours * 60 * 60, walk.timeZone);
      const measured = (measure: string) => since("wellness").some((job) => job.measures.some((value) => value.measure === measure && value.date >= fromDay));
      return { done: proof.measures.every(measured) };
    }
    case "tests":
      return { done: false };
  }
}

/**
 * A sign-in that the walk starts itself, with no SweatStack in front of it. Its relying party belongs to
 * nobody: SweatStack never saw the `state`, the code challenge is random so no verifier matches it, and no
 * client has the empty client id. So the code the consent issues can never be redeemed, and the account is
 * one nobody claims, which the bridge ends a day later.
 */
export async function startSignIn(db: Database, provider: string, landing: string, now: number): Promise<Walk["flow"] & { path: string }> {
  const id = randomToken();
  const expiresAt = now + LINK_SECONDS;
  await db.createFlow({
    id,
    provider,
    platform_verifier: randomToken(),
    rp_client_id: "",
    rp_state: randomToken(),
    rp_nonce: null,
    rp_redirect_uri: landing,
    rp_code_challenge: randomToken(),
    expires_at: expiresAt,
  });
  return { id, expiresAt, path: `/start/${provider}/${id}` };
}

export async function loadWalk(db: Database): Promise<Walk | null> {
  const value = await db.metaValue(WALK_KEY);
  if (value === null) return null;
  try {
    return JSON.parse(value) as Walk;
  } catch {
    return null;
  }
}

export async function saveWalk(db: Database, walk: Walk | null): Promise<void> {
  if (walk === null) await db.deleteMeta(WALK_KEY);
  else await db.setMeta(WALK_KEY, JSON.stringify(walk));
}
