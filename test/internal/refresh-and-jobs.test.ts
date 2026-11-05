import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { accessToken, NeedsReconnect, RefreshInProgress, type ConnectionServices } from "../../src/connections";
import { Database, type ConnectionRow } from "../../src/db";
import { garmin as garminProvider } from "../../src/providers/garmin";
import { GARMIN_HOSTS } from "../fakes/garmin";
import { network } from "../support/network";
import { ALL_PERMISSIONS, resetDatabase, world, type Client } from "../support/world";

const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };
const DAY = 24 * 60 * 60;

const db = new Database(env.DB);
const row = async (sub: string) => (await db.connection(sub)) as ConnectionRow;
const jobs = async () => (await env.DB.prepare("SELECT * FROM inbox ORDER BY id").all<Record<string, unknown>>()).results;

describe("access tokens", () => {
  let w: ReturnType<typeof world>;
  let client: Client;
  let sub: string;

  const services = (): ConnectionServices => {
    const deps = {
      env: { DB: env.DB, GARMIN_CLIENT_ID: w.garmin.clientId, GARMIN_CLIENT_SECRET: w.garmin.clientSecret },
      fetch: network(Object.fromEntries(GARMIN_HOSTS.map((host) => [host, w.garmin.fetch]))),
      now: () => w.clock.now,
      sleep: async () => {},
      waitUntil: () => {},
    };
    return {
      config: { sweatstackUrl: w.sweatstack.url, appId: w.sweatstack.appId, clientSecret: w.sweatstack.clientSecret, backfillDays: 90 },
      db,
      deps,
      provider: garminProvider(deps),
    };
  };

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
    ({ sub } = await w.signIn(client, kari));
  });

  it("uses the stored token while it's good, without calling the platform", async () => {
    const connection = await row(sub);
    expect(await accessToken(services(), connection)).toBe(connection.access_token);
    expect(w.garmin.refreshes).toEqual([]);
  });

  it("refreshes near the end of its life, and stores both new tokens", async () => {
    const before = await row(sub);
    w.clock.now += DAY - 60;
    const token = await accessToken(services(), before);
    const after = await row(sub);
    expect(token).not.toBe(before.access_token);
    expect(after).toMatchObject({ access_token: token, refresh_claimed_until: null });
    expect(after.refresh_token).not.toBe(before.refresh_token);
    expect(w.garmin.refreshes).toEqual([before.refresh_token]);
  });

  it("sends one refresh when two jobs need one at the same moment", async () => {
    const connection = await row(sub);
    w.clock.now += DAY;
    const results = await Promise.allSettled([accessToken(services(), connection), accessToken(services(), connection)]);
    expect(w.garmin.refreshes).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(RefreshInProgress);
  });

  it("uses the new token when someone else refreshed before this job claimed", async () => {
    const stale = await row(sub);
    w.clock.now += DAY;
    const refreshed = await accessToken(services(), stale);
    expect(await accessToken(services(), stale)).toBe(refreshed);
    expect(w.garmin.refreshes).toHaveLength(1);
  });

  it("never reuses a spent refresh token", async () => {
    const stale = await row(sub);
    w.clock.now += DAY;
    await accessToken(services(), stale);
    w.clock.now += DAY;
    await accessToken(services(), stale);
    expect(new Set(w.garmin.refreshes).size).toBe(2);
  });

  it("tries again after a claim has run out, because a Worker stopped mid-refresh", async () => {
    const connection = await row(sub);
    w.clock.now += DAY;
    await db.claimRefresh(sub, w.clock.now, w.clock.now + 60);
    await expect(accessToken(services(), connection)).rejects.toBeInstanceOf(RefreshInProgress);
    w.clock.now += 61;
    expect(await accessToken(services(), connection)).toEqual(expect.any(String));
  });

  it("marks the connection and declares it when the grant is gone", async () => {
    const connection = await row(sub);
    w.garmin.revokeEverything();
    w.clock.now += DAY;
    await expect(accessToken(services(), connection)).rejects.toBeInstanceOf(NeedsReconnect);
    expect(await row(sub)).toMatchObject({ needs_reconnect: 1, refresh_claimed_until: null });
    expect(await jobs()).toEqual([expect.objectContaining({ kind: "declare", sub })]);
  });

  it("keeps the connection as it is when the platform is merely down", async () => {
    const connection = await row(sub);
    w.garmin.failures.token.push(503);
    w.clock.now += DAY;
    await expect(accessToken(services(), connection)).rejects.toMatchObject({ status: 503 });
    expect(await row(sub)).toMatchObject({ needs_reconnect: 0, refresh_claimed_until: null, refresh_token: connection.refresh_token });
  });

  it("keeps a new consent's tokens when a refresh that began before it finishes", async () => {
    const connection = await row(sub);
    const claim = w.clock.now + 60;
    await db.claimRefresh(sub, w.clock.now, claim);
    await w.signIn(client, kari);
    const consented = await row(sub);
    expect(consented.refresh_claimed_until).toBeNull();

    await db.saveRefreshedTokens(sub, claim, { accessToken: "stale", refreshToken: "stale", accessExpiresAt: 1, refreshExpiresAt: 1 });
    expect(await row(sub)).toMatchObject({ access_token: consented.access_token, refresh_token: consented.refresh_token });
    expect(connection.access_token).not.toBe(consented.access_token);
  });
});

describe("a download with a token the platform has stopped accepting", () => {
  it("refreshes once and tries again", async () => {
    await resetDatabase({ withSigningKey: true });
    const w = world();
    await w.signIn(await w.register(), kari);
    w.garmin.invalidateAccessTokens();
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.garmin.refreshes).toHaveLength(1);
    expect(w.sweatstack.uploads).toHaveLength(1);
  });
});

describe("after a reconnect", () => {
  it("relays what waited, without waiting out its backoff", async () => {
    await resetDatabase({ withSigningKey: true });
    const w = world();
    const client = await w.register();
    await w.signIn(client, kari);
    w.garmin.revokeEverything();
    const file = w.garmin.fileReady(kari, "1001");
    await w.ping(file);
    expect(w.sweatstack.uploads).toEqual([]);

    await w.signIn(client, kari);
    await w.settled();
    expect(w.sweatstack.uploads).toHaveLength(1);
  });
});

describe("the job queue", () => {
  let w: ReturnType<typeof world>;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    await w.signIn(await w.register(), kari);
  });

  it("clears what a finished job needed, and keeps the row for the owner", async () => {
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(await jobs()).toEqual([expect.objectContaining({ kind: "activity_file", external_id: "1001", payload: null, last_error: null, done_at: w.clock.now })]);
  });

  it("records why a job gave up", async () => {
    w.garmin.failures.file.push(404);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(await jobs()).toEqual([expect.objectContaining({ last_error: "platform_404", done_at: w.clock.now })]);
  });

  it("gives up after three days, with the reason", async () => {
    for (let failure = 0; failure < 200; failure += 1) w.garmin.failures.file.push(503);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    for (let hour = 0; hour < 73; hour += 1) {
      w.clock.now += 60 * 60;
      await w.cron();
    }
    const [job] = await jobs();
    expect(job).toMatchObject({ last_error: "platform_503" });
    expect(job?.done_at).toEqual(expect.any(Number));
    const attempts = job?.attempts as number;
    w.clock.now += 60 * 60;
    await w.cron();
    expect((await jobs())[0]?.attempts).toBe(attempts);
  });

  it("caps the wait between retries at an hour", async () => {
    for (let failure = 0; failure < 20; failure += 1) w.garmin.failures.file.push(503);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    for (let hour = 0; hour < 12; hour += 1) {
      w.clock.now += 60 * 60;
      await w.cron();
    }
    const [job] = await jobs();
    expect((job?.next_attempt_at as number) - w.clock.now).toBeLessThanOrEqual(60 * 60);
  });

  it("gives a job back when its worker stops mid-job, after the lease", async () => {
    await env.DB.prepare(
      `INSERT INTO inbox (kind, provider, sub, external_id, payload, next_attempt_at, lease_until, received_at)
       SELECT 'activity_file', provider, sub, 'stuck', ?, 0, ?, 0 FROM connections`,
    )
      .bind(JSON.stringify({ callbackUrl: "https://apis.garmin.com/wellness-api/rest/activityFile?id=stuck", activityId: "stuck" }), w.clock.now + 300)
      .run();
    await w.cron();
    expect(w.garmin.downloads).toEqual([]);
    w.clock.now += 301;
    await w.cron();
    expect(w.garmin.downloads).toEqual(["stuck"]);
  });

  it("stops at its limit, and the next run carries on", async () => {
    const files = Array.from({ length: 60 }, (_, index) => w.garmin.fileReady(kari, `file-${index}`));
    await w.webhook("activity-files", { activityFiles: files });
    await w.settled();
    expect(w.sweatstack.uploads).toHaveLength(50);
    await w.cron();
    expect(w.sweatstack.uploads).toHaveLength(60);
  });

  it("purges finished jobs after 30 days, expired tokens and expired flows", async () => {
    await w.ping(w.garmin.fileReady(kari, "1001"));
    w.clock.now += 29 * DAY;
    await w.cron();
    expect(await jobs()).toHaveLength(1);
    w.clock.now += 2 * DAY;
    await w.cron();
    expect(await jobs()).toEqual([]);
    const { results } = await env.DB.prepare("SELECT * FROM tokens").all();
    expect(results).toEqual([]);
  });

  it("changes nothing on a run with nothing to do", async () => {
    const dump = async () => {
      const results = await env.DB.batch(["flows", "connections", "tokens", "inbox", "meta"].map((table) => env.DB.prepare(`SELECT * FROM ${table}`)));
      return JSON.stringify(results.map((result) => result.results));
    };
    await w.cron();
    const before = await dump();
    await w.cron();
    expect(await dump()).toBe(before);
  });
});

describe("a job for a connection that's gone", () => {
  it("tells SweatStack it's over", async () => {
    await resetDatabase({ withSigningKey: true });
    const w = world();
    const { sub } = await w.signIn(await w.register(), kari);
    await env.DB.prepare("DELETE FROM connections WHERE sub = ?").bind(sub).run();
    await db.enqueue({ kind: "declare", provider: "garmin_connect", sub, nextAttemptAt: w.clock.now, receivedAt: w.clock.now });
    await w.cron();
    expect(w.sweatstack.connections.has(sub)).toBe(false);
  });

  it("drops a file for it", async () => {
    await resetDatabase({ withSigningKey: true });
    const w = world();
    const { sub } = await w.signIn(await w.register(), kari);
    await env.DB.prepare("DELETE FROM connections WHERE sub = ?").bind(sub).run();
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.garmin.downloads).toEqual([]);
  });
});

describe("no secret reaches the logs", () => {
  it("logs no token, file address or client secret during a whole relay", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (line: string) => lines.push(String(line));
    try {
      await resetDatabase({ withSigningKey: true });
      const w = world();
      const client = await w.register();
      const { sub } = await w.signIn(client, kari);
      const file = w.garmin.fileReady(kari, "1001");
      w.garmin.failures.file.push(503);
      await w.ping(file);
      await w.ping({ ...file, activityId: "1002", callbackURL: "https://attacker.test/secret-path?token=secret" });
      const connection = await row(sub);
      const logged = lines.join("\n");
      for (const secret of [connection.access_token, connection.refresh_token, client.clientSecret, file.callbackURL, "secret-path", kari.userId]) {
        expect(logged).not.toContain(secret);
      }
      expect(logged).toContain("file_refused");
    } finally {
      console.log = original;
    }
  });
});
