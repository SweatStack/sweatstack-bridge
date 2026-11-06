import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { keepGrantAlive, type ConnectionServices } from "../../src/connections";
import { Database, type ConnectionRow } from "../../src/db";
import { garmin as garminProvider } from "../../src/providers/garmin";
import { GARMIN_HOSTS } from "../fakes/garmin";
import { network } from "../support/network";
import { ALL_PERMISSIONS, PROVIDER, resetDatabase, world, type Client, type WorldOptions } from "../support/world";

const DAY = 24 * 60 * 60;
const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };
const lars = { userId: "garmin-lars", permissions: ALL_PERMISSIONS };

const db = new Database(env.DB);
const row = async (sub: string) => (await db.connection(sub)) as ConnectionRow;
const jobs = async (sub: string) =>
  (await env.DB.prepare("SELECT * FROM inbox WHERE sub = ? ORDER BY id").bind(sub).all<Record<string, unknown>>()).results;
const pending = async (sub: string, kind: string) => (await jobs(sub)).filter((job) => job.kind === kind && job.done_at === null);

let w: ReturnType<typeof world>;
let client: Client;

const setUp = async (options: WorldOptions = {}) => {
  await resetDatabase({ withSigningKey: true });
  w = world(options);
  client = await w.register();
};

const signedIn = async (account = kari) => {
  const result = await w.signIn(client, account);
  await w.settled();
  return result;
};

const enqueueNow = (kind: Parameters<Database["enqueue"]>[0]["kind"], sub: string, receivedAt = w.clock.now) =>
  db.enqueue({ kind, provider: PROVIDER, sub, nextAttemptAt: w.clock.now, receivedAt });

describe("a deregistration", () => {
  beforeEach(() => setUp());

  it("deletes the connection's jobs, and leaves only its own DELETE", async () => {
    const { sub } = await signedIn();
    await enqueueNow("activity_file", sub);
    await env.DB.prepare("UPDATE inbox SET next_attempt_at = ? WHERE kind = 'activity_file'").bind(w.clock.now + 3600).run();
    w.clock.now += 1;
    await w.notify("deregistrations", w.garmin.deregistration(kari));
    const left = await jobs(sub);
    expect(left).toEqual([expect.objectContaining({ kind: "declare", done_at: w.clock.now })]);
    expect(await db.connection(sub)).toBeNull();
  });

  it("doesn't wipe a newer consent when the message was already old", async () => {
    const { sub } = await signedIn();
    const before = await row(sub);
    w.clock.now += 10;
    await signedIn();
    await enqueueNow("deregistration", sub, before.consented_at + 1);
    await w.cron();
    expect(await db.connection(sub)).not.toBeNull();
    expect(w.sweatstack.connections.has(sub)).toBe(true);
    expect(await pending(sub, "declare")).toEqual([]);
  });

  it("doesn't wipe a consent from the very same second: the person can't have disconnected it yet", async () => {
    const { sub } = await signedIn();
    await enqueueNow("deregistration", sub);
    await w.cron();
    expect(await db.connection(sub)).not.toBeNull();
  });

  it("finds the account by its subject and stores no platform id", async () => {
    const { sub } = await signedIn();
    w.clock.now += 1;
    await w.notify("deregistrations", { deregistrations: [{ userId: 123456 }, { nonsense: true }, { userId: kari.userId, userAccessToken: "ignored" }] });
    expect(await db.connection(sub)).toBeNull();
    const { results } = await env.DB.prepare("SELECT * FROM inbox").all();
    expect(JSON.stringify(results)).not.toContain("123456");
    expect(JSON.stringify(results)).not.toContain("ignored");
  });

  it("sends SweatStack the DELETE last, when a declaration was under way as the connection ended", async () => {
    let ending: string | undefined;
    await setUp({
      intercept: async (request) => {
        if (request.method === "PUT" && ending !== undefined) await env.DB.prepare("DELETE FROM connections WHERE sub = ?").bind(ending).run();
        return undefined;
      },
    });
    const { sub } = await signedIn();
    ending = sub;
    await enqueueNow("declare", sub);
    await w.cron();
    expect(w.sweatstack.connections.has(sub)).toBe(false);
  });
});

describe("expiring a connection nobody claimed", () => {
  beforeEach(() => setUp());

  const unclaimed = async () => {
    const starter = w.sweatstack.createUser({});
    const result = await w.signIn(client, kari, { startedBy: starter.id });
    await w.settled();
    return result;
  };

  it("keeps the row and its jobs if a new consent came in while it was at Garmin", async () => {
    const { sub } = await unclaimed();
    const old = await row(sub);
    w.clock.now += 1;
    await unclaimed();
    const before = await jobs(sub);
    await db.forgetUnclaimed(sub, PROVIDER, old.consented_at, w.clock.now);
    expect(await db.connection(sub)).not.toBeNull();
    expect(await jobs(sub)).toEqual(before);
  });

  it("keeps the row if a user was named while it was at Garmin", async () => {
    const { sub } = await unclaimed();
    const old = await row(sub);
    await db.setConnectionUser(sub, "the-user", w.clock.now);
    await db.forgetUnclaimed(sub, PROVIDER, old.consented_at, w.clock.now);
    expect(await row(sub)).toMatchObject({ user_id: "the-user" });
  });

  it("adds one job at a time, and writes nothing on a run with nothing due", async () => {
    const { sub } = await unclaimed();
    w.garmin.failures.registration.push(...Array<number>(100).fill(503));
    w.clock.now += DAY + 1;
    await w.cron();
    await w.cron();
    await w.cron();
    expect(await pending(sub, "expire_unclaimed")).toHaveLength(1);
  });

  it("starts again a day after one gave up", async () => {
    const { sub } = await unclaimed();
    const kept = await row(sub);
    w.clock.now += DAY + 1;
    await enqueueNow("expire_unclaimed", sub);
    await env.DB.prepare("UPDATE inbox SET done_at = ?, last_error = 'x' WHERE kind = 'expire_unclaimed'").bind(w.clock.now).run();
    await w.cron();
    expect(await db.connection(sub)).toMatchObject({ sub: kept.sub });
    w.clock.now += DAY + 1;
    await w.cron();
    expect(await db.connection(sub)).toBeNull();
  });

  it("does nothing if the job finds the connection already claimed", async () => {
    const { sub } = await unclaimed();
    await db.setConnectionUser(sub, "the-user", w.clock.now);
    w.clock.now += DAY + 1;
    await enqueueNow("expire_unclaimed", sub);
    // Even when SweatStack would refuse the last ask, which otherwise reads as nobody's.
    w.sweatstack.selfHosted = false;
    await w.cron();
    expect(w.garmin.deregistered).toEqual([]);
  });

  it("does nothing if a new consent reached the row after the job was added", async () => {
    const { sub } = await unclaimed();
    await enqueueNow("expire_unclaimed", sub);
    await w.cron();
    expect(w.garmin.deregistered).toEqual([]);
    expect(await db.connection(sub)).not.toBeNull();
  });
});

describe("asking for history", () => {
  beforeEach(() => setUp());

  it("keeps its place on the row, and clears it at the end", async () => {
    w.garmin.failures.backfill.push(202, 429);
    const { sub } = await signedIn();
    const held = await row(sub);
    expect(JSON.parse(held.backfill_cursor as string)).toEqual({ end: w.clock.now - 30 * DAY - 1, stop: w.clock.now - 90 * DAY, accepted: true });
    expect(held.backfill_done_at).toBeNull();
    w.clock.now += 60;
    await w.cron();
    expect(await row(sub)).toMatchObject({ backfill_cursor: null, backfill_done_at: w.clock.now });
  });

  it("keeps the same windows after a failure, even much later", async () => {
    w.garmin.failures.backfill.push(202, 429);
    const started = w.clock.now;
    await signedIn();
    w.clock.now += 5 * DAY;
    await w.cron();
    expect(w.garmin.backfills.at(-1)?.start).toBe(started - 90 * DAY);
  });

  it("doesn't let one job's retries pile up over its windows", async () => {
    w.garmin.failures.backfill.push(202, 202, 429);
    const { sub } = await signedIn();
    expect((await pending(sub, "backfill"))[0]).toMatchObject({ attempts: 1, next_attempt_at: w.clock.now + 60, last_error: "platform_429" });
  });

  it("adds one job, however many things ask for one", async () => {
    w.garmin.failures.backfill.push(429, 429, 429);
    const { sub } = await signedIn();
    await signedIn();
    await w.notify("user-permissions", w.garmin.permissionsChanged(kari));
    expect(await pending(sub, "backfill")).toHaveLength(1);
  });

  it("goes at once after a new consent, even if the job was backing off", async () => {
    w.garmin.failures.backfill.push(429);
    await signedIn();
    expect(w.garmin.backfills).toEqual([]);
    await signedIn();
    expect(w.garmin.backfills).toHaveLength(3);
  });

  it("goes at once after a new consent while there's no user yet, with its first seconds back", async () => {
    const starter = w.sweatstack.createUser({});
    w.garmin.failures.backfill.push(429);
    await w.signIn(client, kari, { startedBy: starter.id });
    await w.settled();
    expect(w.garmin.backfills).toEqual([]);

    w.garmin.failures.backfill.push(403);
    await w.signIn(client, kari, { startedBy: starter.id });
    await w.settled();
    expect(w.sleeps).toContain(500);
    expect(w.garmin.backfills).toHaveLength(3);
  });

  it("adds no job for a returning athlete who already has their history", async () => {
    const { sub } = await signedIn();
    await signedIn();
    expect((await jobs(sub)).filter((job) => job.kind === "backfill")).toHaveLength(1);
  });

  it("does nothing if a job finds the history already asked for", async () => {
    const { sub } = await signedIn();
    const asked = w.garmin.backfillRequests.length;
    await enqueueNow("backfill", sub);
    await w.cron();
    expect(w.garmin.backfillRequests).toHaveLength(asked);
  });

  it("doesn't wait behind anyone else's backlog", async () => {
    await signedIn(lars);
    const files = Array.from({ length: 60 }, (_, index) => w.garmin.fileReady(lars, `file-${index}`));
    await w.webhook("activity-files", { activityFiles: files });
    // Leaves that backlog due, and nothing running.
    await w.settled();
    const before = w.sweatstack.uploads.length;
    expect(before).toBe(50);

    await signedIn(kari);
    expect(w.garmin.backfills).toHaveLength(6);
    expect(w.sweatstack.uploads).toHaveLength(before);
  });

  it("stops when the athlete takes the permission away halfway, and carries on if it comes back", async () => {
    const account = { userId: "garmin-kari", permissions: [...ALL_PERMISSIONS] };
    w.garmin.failures.backfill.push(202, 429);
    const { sub } = await signedIn(account);
    account.permissions = ["ACTIVITY_EXPORT"];
    await w.notify("user-permissions", w.garmin.permissionsChanged(account));
    w.clock.now += 60;
    await w.cron();
    expect(w.garmin.backfills).toEqual([]);
    expect((await row(sub)).backfill_done_at).toBeNull();
    expect((await row(sub)).backfill_cursor).not.toBeNull();

    account.permissions = [...ALL_PERMISSIONS];
    await w.notify("user-permissions", w.garmin.permissionsChanged(account));
    expect(w.garmin.backfills).toHaveLength(2);
    expect((await row(sub)).backfill_done_at).toEqual(expect.any(Number));
  });

  it("records it for the owner when Garmin accepted nothing, and asks again on the next consent", async () => {
    w.garmin.failures.backfill.push(400, 400, 400);
    const { sub } = await signedIn();
    expect((await jobs(sub)).find((job) => job.kind === "backfill")).toMatchObject({ last_error: "history_refused" });
    expect(await row(sub)).toMatchObject({ backfill_cursor: null, backfill_done_at: null });
    await signedIn();
    expect(w.garmin.backfills).toHaveLength(3);
  });
});

describe("permissions", () => {
  beforeEach(() => setUp());

  it("stores the list as Garmin gives it", async () => {
    const account = { userId: "garmin-kari", permissions: [...ALL_PERMISSIONS] };
    const { sub } = await signedIn(account);
    account.permissions = ["ACTIVITY_EXPORT", "WORKOUT_IMPORT"];
    await w.notify("user-permissions", w.garmin.permissionsChanged(account, ["SOMETHING_FORGED"]));
    expect(JSON.parse((await row(sub)).permissions as string)).toEqual(account.permissions);
  });

  it("gives up after three days, leaving them unknown", async () => {
    w.garmin.failures.permissions.push(...Array<number>(200).fill(403));
    const { sub } = await signedIn();
    for (let hour = 0; hour < 73; hour += 1) {
      w.clock.now += 3600;
      await w.cron();
    }
    expect(await pending(sub, "permissions_change")).toEqual([]);
    expect((await row(sub)).permissions).toBeNull();
    expect((await jobs(sub)).find((job) => job.kind === "permissions_change")).toMatchObject({ last_error: "permissions_unknown" });
  });

  it("only waits seconds apart on a job's first run", async () => {
    w.garmin.failures.permissions.push(...Array<number>(20).fill(403));
    await signedIn();
    const waited = w.sleeps.length;
    expect(waited).toBe(7);
    w.clock.now += 60;
    await w.cron();
    expect(w.sleeps).toHaveLength(waited);
  });

  it("doesn't touch the token for an account's job after the connection went", async () => {
    const { sub } = await signedIn();
    await env.DB.prepare("DELETE FROM connections WHERE sub = ?").bind(sub).run();
    await enqueueNow("permissions_change", sub);
    await enqueueNow("backfill", sub);
    await enqueueNow("refresh_grant", sub);
    const asked = w.garmin.backfillRequests.length;
    await w.cron();
    expect(w.garmin.backfillRequests).toHaveLength(asked);
    expect(w.garmin.refreshes).toEqual([]);
  });
});

describe("a connection waiting for its athlete to reconnect", () => {
  beforeEach(() => setUp());

  it("doesn't try a refused grant again, or repeat its declaration, however many jobs retry", async () => {
    const { sub } = await signedIn();
    const file = w.garmin.fileReady(kari, "1001");
    w.garmin.revokeEverything();
    await w.ping(file);
    const tried = w.garmin.refreshes.length;
    expect(tried).toBe(1);
    const declared = w.sweatstack.connectionCalls.length;
    for (let hour = 0; hour < 6; hour += 1) {
      w.clock.now += 3600;
      await w.cron();
    }
    expect(w.garmin.refreshes).toHaveLength(tried);
    expect(w.sweatstack.connectionCalls).toHaveLength(declared);
    expect(await pending(sub, "declare")).toEqual([]);
  });
});

describe("refreshing a quiet grant", () => {
  beforeEach(() => setUp());

  const services = (): ConnectionServices => {
    const deps = {
      env: { DB: env.DB, GARMIN_CLIENT_ID: w.garmin.clientId, GARMIN_CLIENT_SECRET: w.garmin.clientSecret },
      fetch: network(Object.fromEntries(GARMIN_HOSTS.map((host) => [host, w.garmin.fetch]))),
      now: () => w.clock.now,
      sleep: async () => {},
      waitUntil: () => {},
    };
    return { config: { sweatstackUrl: w.sweatstack.url, appId: w.sweatstack.appId, clientSecret: w.sweatstack.clientSecret, backfillDays: 90 }, db, deps, provider: garminProvider(deps) };
  };

  it("spends the token once when two runs try at the same moment", async () => {
    const { sub } = await signedIn();
    w.clock.now += 61 * DAY;
    const connection = await row(sub);
    const before = w.clock.now + 30 * DAY;
    await Promise.allSettled([keepGrantAlive(services(), connection, before), keepGrantAlive(services(), connection, before)]);
    expect(w.garmin.refreshes).toHaveLength(1);
  });

  it("doesn't spend it when someone else just did", async () => {
    const { sub } = await signedIn();
    w.clock.now += 61 * DAY;
    const stale = await row(sub);
    const before = w.clock.now + 30 * DAY;
    await keepGrantAlive(services(), stale, before);
    await keepGrantAlive(services(), stale, before);
    expect(w.garmin.refreshes).toHaveLength(1);
    expect(await row(sub)).toMatchObject({ refresh_claimed_until: null });
  });

  it("doesn't spend it when a new consent arrived after the job was added", async () => {
    const { sub } = await signedIn();
    w.clock.now += 61 * DAY;
    await signedIn();
    await enqueueNow("refresh_grant", sub);
    await w.cron();
    expect(w.garmin.refreshes).toEqual([]);
  });

  it("retries when another refresh holds the claim", async () => {
    const { sub } = await signedIn();
    w.clock.now += 61 * DAY;
    await db.claimRefresh(sub, w.clock.now, w.clock.now + 60);
    await w.cron();
    expect(w.garmin.refreshes).toEqual([]);
    expect(await pending(sub, "refresh_grant")).toEqual([expect.objectContaining({ last_error: "refresh_in_progress" })]);
    w.clock.now += 61;
    await w.cron();
    expect(w.garmin.refreshes).toHaveLength(1);
  });

  it("leaves a connection that's waiting for its athlete out of it", async () => {
    const { sub } = await signedIn();
    await env.DB.prepare("UPDATE connections SET needs_reconnect = 1 WHERE sub = ?").bind(sub).run();
    w.clock.now += 61 * DAY;
    await w.cron();
    expect(w.garmin.refreshes).toEqual([]);
    expect(await jobs(sub)).not.toContainEqual(expect.objectContaining({ kind: "refresh_grant" }));
  });
});

describe("a disconnect, against what happens meanwhile", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
  });

  const connected = async () => {
    const { sub } = await w.signIn(client, kari);
    await w.settled();
    return { sub, userId: w.sweatstack.connections.get(sub)?.userId as string };
  };

  it("keeps a consent that landed while Garmin was being asked", async () => {
    const { sub, userId } = await connected();
    w.clock.now += 10;
    w.garmin.beforeDeregistering = async () => {
      w.garmin.beforeDeregistering = async () => {};
      w.clock.now += 10;
      await w.signIn(client, kari);
    };
    expect((await w.disconnect(sub, userId)).status).toBe(204);
    expect(await db.connection(sub)).not.toBeNull();
  });

  it("lets only one of two identical requests through", async () => {
    const { sub, userId } = await connected();
    const answers = await Promise.all([w.disconnect(sub, userId, { jti: "same" }), w.disconnect(sub, userId, { jti: "same" })]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([204, 400]);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
  });

  it("stores no jti for a request that didn't verify, so nobody can fill the table", async () => {
    const { sub, userId } = await connected();
    await w.disconnect(sub, userId, { typ: "JWT", jti: "forged" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM seen_jtis").first("count")).toBe(0);
  });

  it("forgets a jti after a day, long after its five minutes are over", async () => {
    const { sub, userId } = await connected();
    await w.disconnect(sub, userId, { jti: "old" });
    await w.cron();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM seen_jtis").first("count")).toBe(1);
    w.clock.now += 24 * 60 * 60;
    await w.cron();
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM seen_jtis").first("count")).toBe(0);
  });
});

describe("the flow's state on the row", () => {
  const state = async (sub: string) => (await row(sub)).rp_state;

  it("is kept only while the user is unknown", async () => {
    await resetDatabase({ withSigningKey: true });
    const w = world();
    const client = await w.register();
    const starter = w.sweatstack.createUser({});
    const flow = await w.signIn(client, kari, { startedBy: starter.id });
    expect(await state(flow.sub)).toBe(flow.state);

    w.sweatstack.browserReturns(flow.state, flow.sub, { session: starter.id });
    await w.settled();
    expect(await state(flow.sub)).toBeNull();

    // A reconnect: the user is known, so this flow's state will never be sent.
    await w.signIn(client, kari, { startedBy: starter.id });
    await w.settled();
    expect(await state(flow.sub)).toBeNull();
  });
});

/** Garmin only tries again if it's told the ping wasn't taken. */
describe("D1 refusing writes", () => {
  const refusingWrites = (): D1Database =>
    new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch") return () => Promise.reject(new Error("D1_ERROR: writes refused"));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  it("answers a ping with an error, so nothing is lost silently", async () => {
    await resetDatabase({ withSigningKey: true });
    const w = world({ database: refusingWrites() });
    const response = await w.webhook("activity-files", { activityFiles: [w.garmin.fileReady(kari, "1")] });
    expect(response.status).toBe(500);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM inbox").first("count")).toBe(0);
  });
});
