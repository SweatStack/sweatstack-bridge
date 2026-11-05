import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, resetDatabase, world, type Client } from "../support/world";

const DAY = 24 * 60 * 60;
const EVERYTHING = ALL_PERMISSIONS;
const FILES_ONLY = ["ACTIVITY_EXPORT"];
const HISTORY_ONLY = ["HISTORICAL_DATA_EXPORT"];

/** Each test changes what its athlete grants, so each gets its own. */
const athlete = (permissions = EVERYTHING) => ({ userId: "garmin-kari", permissions: [...permissions] });

let w: ReturnType<typeof world>;
let client: Client;

const setUp = async (options: Parameters<typeof world>[0] = {}) => {
  await resetDatabase({ withSigningKey: true });
  w = world(options);
  client = await w.register();
};

const capabilities = (sub: string) => w.sweatstack.connections.get(sub)?.capabilities;
const deletes = () => w.sweatstack.calls.filter((call) => call.method === "DELETE" && call.path.includes("/connections/"));

/** Sign in, and let what it started finish. */
const signedIn = async (account: ReturnType<typeof athlete>, options: { startedBy?: string | null } = {}) => {
  const result = await w.signIn(client, account, options);
  await w.settled();
  return result;
};

/** Contract: "Send the call again on a permission change". What was granted is Garmin's to say, never the body's. */
describe("a change of permissions", () => {
  beforeEach(() => setUp());

  it("declares what Garmin answers now", async () => {
    const kari = athlete();
    const { sub } = await signedIn(kari);
    kari.permissions = HISTORY_ONLY;
    const response = await w.notify("user-permissions", w.garmin.permissionsChanged(kari));
    expect(response.status).toBe(200);
    expect(capabilities(sub)).toMatchObject({ activities: "action_required" });
  });

  it("never believes the body's list", async () => {
    const kari = athlete(FILES_ONLY);
    const { sub } = await signedIn(kari);
    await w.notify("user-permissions", w.garmin.permissionsChanged(kari, EVERYTHING));
    expect(capabilities(sub)).toMatchObject({ activity_history: "action_required" });
    expect(w.garmin.backfillRequests).toEqual([]);
  });

  it("stops relaying files once they're no longer allowed", async () => {
    const kari = athlete();
    await signedIn(kari);
    kari.permissions = HISTORY_ONLY;
    await w.notify("user-permissions", w.garmin.permissionsChanged(kari));
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.garmin.downloads).toEqual([]);
  });

  it("tries again when Garmin can't answer, and changes nothing until it can", async () => {
    const kari = athlete();
    const { sub } = await signedIn(kari);
    const before = capabilities(sub);
    kari.permissions = HISTORY_ONLY;
    w.garmin.failures.permissions.push(503, 503, 503, 503);
    await w.notify("user-permissions", w.garmin.permissionsChanged(kari));
    expect(capabilities(sub)).toEqual(before);
    w.clock.now += 60;
    await w.cron();
    expect(capabilities(sub)).toMatchObject({ activities: "action_required" });
  });

  it("refreshes once when Garmin has stopped accepting the access token", async () => {
    const kari = athlete();
    const { sub } = await signedIn(kari);
    kari.permissions = HISTORY_ONLY;
    w.garmin.invalidateAccessTokens();
    await w.notify("user-permissions", w.garmin.permissionsChanged(kari));
    expect(w.garmin.refreshes).toHaveLength(1);
    expect(capabilities(sub)).toMatchObject({ activities: "action_required" });
  });

  it("does nothing for an account it doesn't hold", async () => {
    const response = await w.notify("user-permissions", w.garmin.permissionsChanged(athlete()));
    expect(response.status).toBe(200);
    expect(w.sweatstack.connectionCalls).toEqual([]);
  });

  it("refuses a wrong secret", async () => {
    const kari = athlete();
    const { sub } = await signedIn(kari);
    const before = w.sweatstack.connectionCalls.length;
    const response = await w.webhook("user-permissions", w.garmin.permissionsChanged(kari), { secret: "not-the-secret" });
    expect(response.status).toBe(404);
    await w.settled();
    expect(w.sweatstack.connectionCalls).toHaveLength(before);
    expect(capabilities(sub)).toBeDefined();
  });
});

describe("permissions Garmin won't give right after consent", () => {
  beforeEach(() => setUp());

  it("reads as unknown, never as missing, while it asks again seconds apart", async () => {
    const kari = athlete(FILES_ONLY);
    w.garmin.failures.permissions.push(403, 403, 403);
    const { sub } = await w.signIn(client, kari);
    expect(w.sweatstack.connectionCalls[0]?.capabilities).toMatchObject({ activity_history: "syncing" });
    await w.settled();
    expect(w.sleeps.slice(0, 2)).toEqual([1000, 2000]);
    expect(capabilities(sub)).toMatchObject({ activity_history: "action_required" });
  });

  it("keeps asking on later runs when seconds weren't enough", async () => {
    const kari = athlete(FILES_ONLY);
    w.garmin.failures.permissions.push(...Array<number>(5).fill(403));
    const { sub } = await signedIn(kari);
    expect(capabilities(sub)).toMatchObject({ activity_history: "syncing" });
    w.clock.now += 60;
    await w.cron();
    expect(capabilities(sub)).toMatchObject({ activity_history: "action_required" });
  });

  it("doesn't fail the sign-in when Garmin refuses the new token on that first ask", async () => {
    w.garmin.failures.permissions.push(401);
    const { sub } = await signedIn(athlete());
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("asks Garmin for history once it knows that's allowed", async () => {
    w.garmin.failures.permissions.push(403, 403);
    await signedIn(athlete());
    expect(w.garmin.backfills.length).toBeGreaterThan(0);
  });

  it("doesn't ask for history while it doesn't know", async () => {
    w.garmin.failures.permissions.push(...Array<number>(5).fill(403));
    await signedIn(athlete());
    expect(w.garmin.backfillRequests).toEqual([]);
  });
});

/** Contract: "`DELETE` the same URL when a connection ends, for example on the platform's deregistration." */
describe("a deregistration from Garmin", () => {
  beforeEach(() => setUp());

  /** Garmin's notification comes after the consent it ends. */
  const deregister = async (account: ReturnType<typeof athlete>) => {
    w.clock.now += 1;
    return w.notify("deregistrations", w.garmin.deregistration(account));
  };

  it("declares the DELETE", async () => {
    const kari = athlete();
    const { sub } = await signedIn(kari);
    const response = await deregister(kari);
    expect(response.status).toBe(200);
    expect(w.sweatstack.connections.has(sub)).toBe(false);
    expect(deletes()).toHaveLength(1);
  });

  it("relays nothing afterwards", async () => {
    const kari = athlete();
    await signedIn(kari);
    await deregister(kari);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.garmin.downloads).toEqual([]);
    expect(w.sweatstack.uploads).toEqual([]);
  });

  it("doesn't call Garmin back: Garmin is the one saying it's over", async () => {
    const kari = athlete();
    await signedIn(kari);
    await deregister(kari);
    expect(w.garmin.deregistered).toEqual([]);
  });

  it("does nothing for the echo of a deregistration that's already done", async () => {
    const kari = athlete();
    await signedIn(kari);
    await deregister(kari);
    await deregister(kari);
    expect(deletes()).toHaveLength(1);
  });

  it("does nothing for an account it never held", async () => {
    await deregister(athlete());
    expect(deletes()).toEqual([]);
  });

  it("repeats the DELETE until SweatStack has it", async () => {
    let failures = 1;
    await setUp({
      intercept: (request) => {
        if (request.method === "DELETE" && failures > 0) {
          failures -= 1;
          return new Response(null, { status: 503 });
        }
        return undefined;
      },
    });
    const kari = athlete();
    const { sub } = await signedIn(kari);
    await deregister(kari);
    expect(w.sweatstack.connections.has(sub)).toBe(true);
    w.clock.now += 60;
    await w.cron();
    expect(w.sweatstack.connections.has(sub)).toBe(false);
  });

  it("gives the same user back when the same Garmin account returns", async () => {
    const kari = athlete();
    const first = await signedIn(kari);
    const user = w.sweatstack.connections.get(first.sub)?.userId;
    await deregister(kari);
    const second = await signedIn(kari);
    expect(second.sub).toBe(first.sub);
    expect(w.sweatstack.connections.get(second.sub)?.userId).toBe(user);
  });
});

/** Contract: "If a connection gets no `user_id` within 24 hours, deregister it at the platform and delete it." */
describe("a connection nobody ever claims", () => {
  beforeEach(() => setUp());

  /** A forwarded link: someone started this from their Portal, and it never comes back to them. */
  const unclaimed = async (account = athlete()) => {
    const starter = w.sweatstack.createUser({});
    const result = await w.signIn(client, account, { startedBy: starter.id });
    await w.settled();
    return { ...result, starter };
  };
  const hoursLater = async (hours: number) => {
    w.clock.now += hours * 60 * 60;
    await w.cron();
  };

  it("stays for a day", async () => {
    const { sub } = await unclaimed();
    await hoursLater(23);
    expect(w.garmin.deregistered).toEqual([]);
    expect(w.sweatstack.connections.has(sub)).toBe(true);
  });

  it("is deregistered at Garmin after a day, and its DELETE is declared", async () => {
    const kari = athlete();
    const { sub } = await unclaimed(kari);
    await hoursLater(25);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
    expect(w.sweatstack.connections.has(sub)).toBe(false);
    expect(w.sweatstack.uploads).toEqual([]);
  });

  it("is only deregistered once, and the echo does nothing", async () => {
    const kari = athlete();
    await unclaimed(kari);
    await hoursLater(25);
    await w.notify("deregistrations", w.garmin.deregistration(kari));
    await hoursLater(25);
    expect(w.garmin.deregistered).toHaveLength(1);
    expect(deletes()).toHaveLength(1);
  });

  it("uploads nothing that was waiting for it", async () => {
    const kari = athlete();
    await unclaimed(kari);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    await hoursLater(25);
    await hoursLater(1);
    expect(w.garmin.downloads).toEqual([]);
    expect(w.sweatstack.uploads).toEqual([]);
  });

  it("stays while Garmin is unreachable, and goes when it's back", async () => {
    w.garmin.failures.registration.push(503);
    const kari = athlete();
    const { sub } = await unclaimed(kari);
    await hoursLater(25);
    expect(w.sweatstack.connections.has(sub)).toBe(true);
    await hoursLater(1);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
    expect(w.sweatstack.connections.has(sub)).toBe(false);
  });

  it("goes anyway when Garmin says the token is already gone", async () => {
    const { sub } = await unclaimed();
    w.garmin.revokeEverything();
    await hoursLater(25);
    expect(w.garmin.deregistered).toEqual([]);
    expect(w.sweatstack.connections.has(sub)).toBe(false);
  });

  it("goes anyway when Garmin refuses the deregistration itself: there's nothing left to deregister", async () => {
    w.garmin.failures.registration.push(400);
    const { sub } = await unclaimed();
    await hoursLater(25);
    expect(w.garmin.deregistered).toEqual([]);
    expect(w.sweatstack.connections.has(sub)).toBe(false);
  });

  it("is kept when SweatStack named its user at the very end", async () => {
    const { sub, state, starter } = await unclaimed();
    w.sweatstack.browserReturns(state, sub, { session: starter.id });
    await hoursLater(25);
    expect(w.garmin.deregistered).toEqual([]);
    expect(w.sweatstack.connections.get(sub)?.userId).toBe(starter.id);
    expect(deletes()).toEqual([]);
  });

  it("is kept while SweatStack is down: an outage must not cost an athlete their grant", async () => {
    let down = false;
    await setUp({ intercept: () => (down ? new Response(null, { status: 503 }) : undefined) });
    const { sub } = await unclaimed();
    down = true;
    await hoursLater(25);
    expect(w.garmin.deregistered).toEqual([]);
    down = false;
    await hoursLater(1);
    expect(w.garmin.deregistered).toHaveLength(1);
    expect(w.sweatstack.connections.has(sub)).toBe(false);
  });

  it("goes when the app's card isn't self-hosted any more, because there's nobody to hand it to", async () => {
    const kari = athlete();
    await unclaimed(kari);
    w.sweatstack.selfHosted = false;
    await hoursLater(25);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
  });

  it("counts the day from the latest consent", async () => {
    const kari = athlete();
    await unclaimed(kari);
    await hoursLater(23);
    await unclaimed(kari);
    await hoursLater(2);
    expect(w.garmin.deregistered).toEqual([]);
  });

  it("leaves a connection with a user alone, however old", async () => {
    const { sub } = await signedIn(athlete());
    await hoursLater(24 * 10);
    expect(w.garmin.deregistered).toEqual([]);
    expect(w.sweatstack.connections.has(sub)).toBe(true);
  });
});

/** History, and each answer Garmin can give when asked for it. */
describe("asking Garmin for history", () => {
  beforeEach(() => setUp());

  const windowOf = (window: { start: number; end: number }) => window.end - window.start;

  it("covers the whole of BACKFILL_DAYS in windows of up to 30 days, newest first, with no gap", async () => {
    await signedIn(athlete());
    const started = w.clock.now;
    const windows = w.garmin.backfills;
    expect(windows).toHaveLength(3);
    expect(windows[0]?.end).toBe(started);
    expect(windows[2]?.start).toBe(started - 90 * DAY);
    for (const window of windows) expect(windowOf(window)).toBeLessThanOrEqual(30 * DAY);
    expect(windows[1]?.end).toBe((windows[0]?.start as number) - 1);
    expect(windows[2]?.end).toBe((windows[1]?.start as number) - 1);
  });

  it.each([
    ["1", 1],
    ["30", 1],
    ["31", 2],
    ["365", 13],
  ])("asks the right number of windows for BACKFILL_DAYS=%s", async (days, expected) => {
    await setUp({ settings: { BACKFILL_DAYS: days } });
    await signedIn(athlete());
    expect(w.garmin.backfills).toHaveLength(expected);
    expect(w.garmin.backfills.at(-1)?.start).toBe(w.clock.now - Number(days) * DAY);
  });

  it("reads syncing until the last window is accepted, then ready, and says so", async () => {
    const { sub } = await signedIn(athlete());
    const said = w.sweatstack.connectionCalls.filter((call) => call.subject === sub).map((call) => call.capabilities);
    expect(said[0]).toMatchObject({ activities: "syncing", activity_history: "syncing" });
    expect(said.at(-1)).toMatchObject({ activities: "ready", activity_history: "ready" });
  });

  it("doesn't make the browser wait for Garmin", async () => {
    let release = () => {};
    w.garmin.backfillGate = new Promise((resolve) => (release = resolve));
    const flow = await w.consent(client, athlete());
    expect(flow.code).toEqual(expect.any(String));
    expect(w.garmin.backfills).toEqual([]);
    release();
    await w.settled();
    expect(w.garmin.backfills).toHaveLength(3);
  });

  it("asks only after the connection call, which can make the user and which this work may repeat", async () => {
    const askedDuringTheCall: number[] = [];
    await setUp({
      intercept: async (request) => {
        if (request.method === "PUT") {
          await new Promise((resolve) => setTimeout(resolve, 20));
          askedDuringTheCall.push(w.garmin.backfillRequests.length);
        }
        return undefined;
      },
    });
    await w.consent(client, athlete());
    expect(askedDuringTheCall[0]).toBe(0);
    await w.settled();
    expect(w.garmin.backfills).toHaveLength(3);
  });

  it("asks at Garmin's callback, before SweatStack has a user to give", async () => {
    const starter = w.sweatstack.createUser({});
    await signedIn(athlete(), { startedBy: starter.id });
    expect(w.garmin.backfills).toHaveLength(3);
  });

  it("waits a moment on a 403 right after consent, and doesn't leave it to the next run", async () => {
    w.garmin.failures.backfill.push(403, 403);
    const { sub } = await signedIn(athlete());
    expect(w.sleeps.slice(0, 2)).toEqual([1000, 2000]);
    expect(w.garmin.backfills).toHaveLength(3);
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("carries on later when the 403s don't stop", async () => {
    w.garmin.failures.backfill.push(...Array<number>(4).fill(403));
    const { sub } = await signedIn(athlete());
    expect(w.garmin.backfills).toEqual([]);
    expect(capabilities(sub)).toMatchObject({ activity_history: "syncing" });
    w.clock.now += 60;
    await w.cron();
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("stops at a 429, and carries on from where it was, without repeating what was accepted", async () => {
    w.garmin.failures.backfill.push(202, 429);
    const { sub } = await signedIn(athlete());
    expect(w.garmin.backfillRequests).toHaveLength(2);
    expect(capabilities(sub)).toMatchObject({ activity_history: "syncing" });

    w.clock.now += 60;
    await w.cron();
    const starts = w.garmin.backfillRequests.map((window) => window.start);
    expect(starts).toHaveLength(4);
    expect(starts[1]).toBe(starts[2]);
    expect(new Set(starts).size).toBe(3);
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("treats a 409 as accepted", async () => {
    w.garmin.failures.backfill.push(409, 409, 409);
    const { sub } = await signedIn(athlete());
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("skips a window another 4xx refuses, and finishes with the others", async () => {
    w.garmin.failures.backfill.push(400);
    const { sub } = await signedIn(athlete());
    expect(w.garmin.backfills).toHaveLength(2);
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("finishes when only the oldest window is refused, as one before Garmin's floor is", async () => {
    w.garmin.failures.backfill.push(202, 202, 400);
    const { sub } = await signedIn(athlete());
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("doesn't say ready when Garmin accepted nothing, and doesn't keep asking", async () => {
    w.garmin.failures.backfill.push(400, 400, 400);
    const { sub } = await signedIn(athlete());
    expect(capabilities(sub)).toMatchObject({ activity_history: "syncing" });
    const asked = w.garmin.backfillRequests.length;
    w.clock.now += 2 * DAY;
    await w.cron();
    expect(w.garmin.backfillRequests).toHaveLength(asked);
  });

  it("retries a window Garmin couldn't answer", async () => {
    w.garmin.failures.backfill.push(503);
    const { sub } = await signedIn(athlete());
    expect(w.garmin.backfills).toEqual([]);
    w.clock.now += 60;
    await w.cron();
    expect(w.garmin.backfills).toHaveLength(3);
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("refreshes once when Garmin has stopped accepting the access token", async () => {
    w.garmin.failures.backfill.push(401);
    await signedIn(athlete());
    expect(w.garmin.refreshes).toHaveLength(1);
    expect(w.garmin.backfills).toHaveLength(3);
  });

  it("doesn't ask when the athlete didn't grant it", async () => {
    const { sub } = await signedIn(athlete(FILES_ONLY));
    expect(w.garmin.backfillRequests).toEqual([]);
    expect(capabilities(sub)).toMatchObject({ activities: "syncing", activity_history: "action_required" });
  });

  it("doesn't ask when the app doesn't offer it, even if Garmin says it's granted", async () => {
    await setUp({ settings: { GARMIN_APP_OFFERS: "activities" } });
    const { sub } = await signedIn(athlete());
    expect(w.garmin.backfillRequests).toEqual([]);
    expect(capabilities(sub)).toMatchObject({ activities: "ready", activity_history: "unavailable" });
  });

  it("asks a returning athlete who newly granted it, by signing in again", async () => {
    const kari = athlete(FILES_ONLY);
    const { sub } = await signedIn(kari);
    kari.permissions = EVERYTHING;
    await signedIn(kari);
    expect(w.garmin.backfills).toHaveLength(3);
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("asks an athlete who newly granted it through a permission change", async () => {
    const kari = athlete(FILES_ONLY);
    const { sub } = await signedIn(kari);
    kari.permissions = EVERYTHING;
    await w.notify("user-permissions", w.garmin.permissionsChanged(kari));
    expect(w.garmin.backfills).toHaveLength(3);
    expect(capabilities(sub)).toMatchObject({ activity_history: "ready" });
  });

  it("doesn't ask twice for an athlete who already has it", async () => {
    const kari = athlete();
    await signedIn(kari);
    const asked = w.garmin.backfillRequests.length;
    await signedIn(kari);
    await w.notify("user-permissions", w.garmin.permissionsChanged(kari));
    expect(w.garmin.backfillRequests).toHaveLength(asked);
  });

  it("asks again for an athlete who deregistered and came back: SweatStack dedupes the files", async () => {
    const kari = athlete();
    await signedIn(kari);
    w.clock.now += 1;
    await w.notify("deregistrations", w.garmin.deregistration(kari));
    w.clock.now += 1;
    await signedIn(kari);
    expect(w.garmin.backfills).toHaveLength(6);
  });

  it("relays what Garmin sends back like any other file", async () => {
    const kari = athlete();
    await signedIn(kari);
    await w.ping(w.garmin.fileReady(kari, "old-1"), w.garmin.fileReady(kari, "old-2"));
    expect(w.sweatstack.uploads.map((upload) => upload.externalId).sort()).toEqual(["old-1", "old-2"]);
  });

  it("asks when the owner starts offering history, for everyone already connected", async () => {
    await setUp({ settings: { GARMIN_APP_OFFERS: "activities" } });
    const kari = athlete();
    await w.cron();
    const { sub } = await signedIn(kari);
    expect(w.garmin.backfillRequests).toEqual([]);

    const before = w;
    const after = world({ settings: { GARMIN_APP_OFFERS: "activities,activity_history" }, garmin: before.garmin });
    after.clock.now = before.clock.now;
    await after.cron();
    expect(before.garmin.backfills).toHaveLength(3);
    expect(after.sweatstack.connections.get(sub)?.capabilities).toMatchObject({ activity_history: "ready" });
  });
});

/** Nothing else calls Garmin for an athlete who trains on nothing that syncs. */
describe("a quiet athlete's grant", () => {
  beforeEach(() => setUp());

  const daysLater = async (days: number) => {
    w.clock.now += days * DAY;
    await w.cron();
  };

  it("is left alone until 30 days before it lapses", async () => {
    await signedIn(athlete());
    await daysLater(59);
    expect(w.garmin.refreshes).toEqual([]);
  });

  it("is refreshed once inside those 30 days", async () => {
    await signedIn(athlete());
    await daysLater(61);
    expect(w.garmin.refreshes).toHaveLength(1);
    await w.cron();
    await daysLater(1);
    expect(w.garmin.refreshes).toHaveLength(1);
  });

  it("survives for years, and still downloads at the end", async () => {
    const kari = athlete();
    await signedIn(kari);
    for (let period = 0; period < 20; period += 1) await daysLater(61);
    expect(w.garmin.refreshes).toHaveLength(20);
    expect(new Set(w.garmin.refreshes).size).toBe(20);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.sweatstack.uploads).toHaveLength(1);
  });

  it("backs off while Garmin is down, instead of asking every minute", async () => {
    await signedIn(athlete());
    w.garmin.failures.token.push(...Array<number>(10).fill(503));
    await daysLater(61);
    for (let run = 0; run < 3; run += 1) {
      w.clock.now += 15;
      await w.cron();
    }
    expect(w.garmin.failures.token).toHaveLength(9);
    w.clock.now += 60 * 60;
    await w.cron();
    expect(w.garmin.failures.token.length).toBeLessThan(9);
  });

  it("is declared action_required when Garmin refuses it, and isn't tried again", async () => {
    const { sub } = await signedIn(athlete());
    w.garmin.revokeEverything();
    await daysLater(61);
    expect(capabilities(sub)).toMatchObject({ activities: "action_required", activity_history: "action_required" });
    const tried = w.garmin.refreshes.length;
    await daysLater(1);
    await daysLater(1);
    expect(w.garmin.refreshes).toHaveLength(tried);
  });

  it("gets at most one try a day when Garmin refuses for another reason", async () => {
    await signedIn(athlete());
    w.garmin.failures.token.push(...Array<number>(10).fill(400));
    await daysLater(61);
    const remaining = w.garmin.failures.token.length;
    expect(remaining).toBe(9);
    for (let minute = 0; minute < 3; minute += 1) {
      w.clock.now += 60;
      await w.cron();
    }
    expect(w.garmin.failures.token).toHaveLength(remaining);
    await daysLater(1);
    expect(w.garmin.failures.token).toHaveLength(remaining - 1);
  });

  it("comes back to life after a reconnect", async () => {
    const kari = athlete();
    const { sub } = await signedIn(kari);
    w.garmin.revokeEverything();
    await daysLater(61);
    await signedIn(kari);
    expect(capabilities(sub)).toMatchObject({ activities: "ready", activity_history: "ready" });
    await daysLater(61);
    expect(capabilities(sub)).toMatchObject({ activities: "ready" });
  });
});
