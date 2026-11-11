import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { guide, localDay } from "../../scripts/lib/verify-guide.mjs";
import type { Account } from "../fakes/garmin";
import { ORIGIN, pathOf, resetDatabase, world } from "../support/world";

/**
 * `npm run verify` walking the owner through Garmin's partner verification, against a fake Garmin: each step
 * goes on once its data reaches the bridge, and the place survives a stop.
 */

const HOUR = 60 * 60;
const EVERYTHING = ["ACTIVITY_EXPORT", "HISTORICAL_DATA_EXPORT", "HEALTH_EXPORT"];
const accountA: Account = { userId: "garmin-a", permissions: EVERYTHING };
const accountB: Account = { userId: "garmin-b", permissions: EVERYTHING };

type State = { step: string; since: number; flow?: { path: string }; accounts: Record<string, string> };
type W = ReturnType<typeof world>;
/** What the owner does while the guide waits at a step. Returns what they type, if anything. */
type Action = (w: W, state: State) => Promise<string | null | void>;

let w: W;

beforeEach(async () => {
  await resetDatabase({ withSigningKey: true });
  w = world({ sweatstack: { selfHosted: false }, settings: { GARMIN_APP_OFFERS: "activities,wellness" } });
});

const signInWith = (account: Account) => async (w: W, state: State) => {
  const started = await w.request(state.flow?.path as string);
  await w.request(pathOf(w.garmin.approve(started.headers.get("Location") as string, account)));
  await w.settled();
};

const pushWellness = async (kind: string, body: unknown) => {
  await w.webhook(kind, body);
  await w.settled();
};

const day = (seconds: number) => localDay(seconds);

/** The owner's part, step by step, as the runbook asks. */
const OWNER: Record<string, Action> = {
  connect_a: signInWith(accountA),
  walk_a: async () => void (await w.ping(w.garmin.fileReady(accountA, "walk-a"))),
  connect_b: signInWith(accountB),
  walk_b: async () => void (await w.ping(w.garmin.fileReady(accountB, "walk-b"))),
  permission_b: async () => void (await w.notify("user-permissions", w.garmin.permissionsChanged(accountB, ["ACTIVITY_EXPORT"]))),
  remove_b: async () => {
    // A deregistration ends only a consent older than itself.
    w.clock.now += 60;
    await w.notify("deregistrations", w.garmin.deregistration(accountB));
  },
  weight_a: () => pushWellness("body-compositions", { bodyComps: [{ userId: accountA.userId, measurementTimeInSeconds: w.clock.now, weightInGrams: 70_000 }] }),
  night_a: async () => {
    w.clock.now += 10 * HOUR;
    const night = day(w.clock.now);
    await pushWellness("sleeps", { sleeps: [{ userId: accountA.userId, calendarDate: night, durationInSeconds: 28_000 }] });
    await pushWellness("hrv", { hrv: [{ userId: accountA.userId, calendarDate: night, lastNightAvg: 60 }] });
  },
};

/**
 * Runs the guide with the owner doing `owner`'s part at each step, once. A step that waits on, with the owner
 * done, stops the run with q, so a test can't hang.
 */
async function run({ owner = OWNER, wellness = true, saved = null as State | null, answers = [] as string[] } = {}) {
  let state = saved;
  const printed: string[] = [];
  const done = new Set<string>();
  const walks: string[] = [];
  const queued = [...answers];
  const io = {
    print: (text: string) => void printed.push(text),
    ask: async (question: string) => {
      printed.push(question);
      return queued.shift() ?? "";
    },
    idle: async () => {
      const current = state as State;
      const action = owner[current.step];
      if (action === undefined || done.has(current.step)) return "q";
      done.add(current.step);
      return (await action(w, current)) ?? null;
    },
  };
  await guide(io, {
    name: "sweatstack-bridge",
    origin: ORIGIN,
    wellness,
    now: () => w.clock.now,
    query: async (sql: string) => (await env.DB.prepare(sql).all()).results,
    execute: async (sql: string) => (await env.DB.prepare(sql).run()).success,
    writeWalk: async () => {
      walks.push(`walk-${walks.length + 1}.fit`);
      return walks.at(-1) as string;
    },
    loadState: () => (state === null ? null : structuredClone(state)),
    saveState: (next: State | null) => void (state = next === null ? null : structuredClone(next)),
  });
  return { printed: printed.join("\n"), state, walks };
}

describe("npm run verify", () => {
  it("walks through every step for an app with wellness, going on as each one's data arrives", async () => {
    const { printed, state } = await run();
    for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(printed).toContain(`Step ${step} of 10`);
    const confirmations = [
      "Account A is connected.",
      "Garmin sent account A's activity file.",
      "Account B is connected.",
      "Garmin sent account B's activity file.",
      "Garmin sent account B's permission change.",
      "Garmin sent account B's deregistration.",
      "Garmin sent account A's weight.",
      "Garmin sent account A's sleep and HRV status.",
    ];
    const positions = confirmations.map((line) => printed.indexOf(line));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(printed).toContain("Done.");
    expect(state).toBeNull();
  });

  it("asks an app without wellness for two accounts, two activities, a permission and a removal: 8 steps", async () => {
    const { printed, state } = await run({ wellness: false });
    expect(printed).toContain("There are 8 steps");
    expect(printed).toContain("Step 8 of 8: Garmin's tests");
    expect(printed).not.toContain("weight");
    expect(printed).not.toContain("watch tonight");
    expect(printed).toContain("Account A: your own. It needs no watch.");
    expect(state).toBeNull();
  });

  it("prints a sign-in link on the bridge's address", async () => {
    const { printed } = await run();
    expect(printed).toMatch(new RegExp(`${ORIGIN}/start/garmin_connect/[\\w-]{43}`));
  });

  it("asks only to take a permission back", async () => {
    const { printed } = await run();
    expect(printed).toContain("With account B, turn off one of your app's permissions in Garmin Connect.");
  });

  it("stops for the night, and carries on there the next morning", async () => {
    const { printed, state } = await run({ owner: { ...OWNER, night_a: async () => "q" } });
    expect(printed).toContain("Stopped at step 9. Run npm run verify again to carry on there.");
    expect(state?.step).toBe("night_a");

    const morning = await run({ saved: state });
    expect(morning.printed).toContain("You stopped at step 9, a night with the watch.");
    expect(morning.printed).not.toContain("Step 8 of 10");
    expect(morning.printed).toContain("Garmin sent account A's sleep and HRV status.");
    expect(morning.state).toBeNull();
  });

  it("doesn't count a night that Garmin sent as history", async () => {
    const owner = {
      ...OWNER,
      night_a: async () => {
        const lastNight = day(w.clock.now - 12 * HOUR);
        await pushWellness("sleeps", { sleeps: [{ userId: accountA.userId, calendarDate: lastNight, durationInSeconds: 28_000 }] });
        await pushWellness("hrv", { hrv: [{ userId: accountA.userId, calendarDate: lastNight, lastNightAvg: 60 }] });
      },
    };
    const { printed, state } = await run({ owner });
    expect(printed).not.toContain("Garmin sent account A's sleep");
    expect(state?.step).toBe("night_a");
  });

  it("starts again from a new link when Garmin doesn't connect the account", async () => {
    const owner = {
      ...OWNER,
      connect_a: async (w: W, state: State) => {
        const started = await w.request(state.flow?.path as string);
        await w.request(pathOf(w.garmin.deny(started.headers.get("Location") as string)));
      },
    };
    const { printed, state } = await run({ owner });
    expect(printed).toContain("Garmin didn't connect the account. Here's a new link.");
    expect(state?.step).toBe("connect_a");
  });

  it("gives a new link when asked", async () => {
    const { printed } = await run({ owner: { ...OWNER, connect_a: async () => "n" } });
    expect(printed).toContain("Here's a new link.");
    expect(printed.match(/\/start\/garmin_connect\//g)).toHaveLength(2);
  });

  it("notices account A signed in again where B should be", async () => {
    const { printed, state } = await run({ owner: { ...OWNER, connect_b: signInWith(accountA) } });
    expect(printed).toContain("That was account A. Sign out of Garmin, or use a new private window, and sign in with account B.");
    expect(state?.step).toBe("connect_b");
  });

  it("lets the owner skip a check, and go on", async () => {
    const { printed, state } = await run({ owner: { ...OWNER, walk_a: async () => "s" } });
    expect(printed).toContain("Skipped. Garmin's tests will show whether it came.");
    expect(state).toBeNull();
  });

  it("starts again at connecting account A once the bridge has ended that connection", async () => {
    const { state } = await run({ owner: { ...OWNER, night_a: async () => "q" } });
    w.clock.now += 25 * HOUR;
    await w.cron();
    const later = await run({ saved: state });
    expect(later.printed).toContain("The bridge has ended account A's connection: it does that a day after the sign-in. Starting again at step 2.");
    expect(later.printed).toContain("Account A is connected.");
    expect(later.state).toBeNull();
  });

  it("starts over when asked", async () => {
    const { state } = await run({ owner: { ...OWNER, night_a: async () => "q" } });
    const again = await run({ saved: state, answers: ["new"] });
    expect(again.printed).toContain("Step 1 of 10");
  });

  it("starts over when the saved step isn't one this app has, as after it stopped offering wellness", async () => {
    const { state } = await run({ owner: { ...OWNER, night_a: async () => "q" } });
    const again = await run({ saved: state, wellness: false });
    expect(again.printed).not.toContain("You stopped at");
    expect(again.printed).toContain("Step 1 of 8");
  });
});
