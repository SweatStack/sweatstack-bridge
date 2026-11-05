import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, resetDatabase, world, type Client } from "../support/world";

const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };

/** Contract: "Upload data". What SweatStack sees of a file, from the ping to the upload. */
describe("relaying a file", () => {
  let w: ReturnType<typeof world>;
  let client: Client;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
    const { sub } = await w.signIn(client, kari);
    userId = w.sweatstack.connections.get(sub)?.userId as string;
  });

  it("uploads a file as the athlete, deduplicated on the platform's activity id", async () => {
    const response = await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(response.status).toBe(200);
    expect(w.sweatstack.uploads).toEqual([
      { userId, externalId: "1001", provider: "garmin_connect", filename: "1001.fit", content: "FIT-1001" },
    ]);
  });

  it("acknowledges before it works, so a slow SweatStack can't hold up the platform", async () => {
    const response = await w.webhook("activity-files", { activityFiles: [w.garmin.fileReady(kari, "1001")] });
    expect(response.status).toBe(200);
    expect(w.sweatstack.uploads).toEqual([]);
    await w.settled();
    expect(w.sweatstack.uploads).toHaveLength(1);
  });

  it("downloads the address exactly as given, with its token parameter", async () => {
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.garmin.downloads).toEqual(["1001"]);
    expect(w.sweatstack.uploads[0]?.content).toBe("FIT-1001");
  });

  it("relays several files from one ping", async () => {
    await w.ping(w.garmin.fileReady(kari, "1001"), w.garmin.fileReady(kari, "1002"));
    expect(w.sweatstack.uploads.map((upload) => upload.externalId).sort()).toEqual(["1001", "1002"]);
  });

  it("relays a file once when the platform pings about it twice", async () => {
    const file = w.garmin.fileReady(kari, "1001");
    await w.ping(file);
    await w.ping(file);
    expect(w.sweatstack.uploads).toHaveLength(1);
  });

  it.each([
    ["a format the relay doesn't take", { fileType: "TCX" }],
    ["a manual activity, which has no file", { manual: true }],
  ])("skips %s", async (_name, overrides) => {
    await w.ping(w.garmin.fileReady(kari, "1001", overrides));
    expect(w.garmin.downloads).toEqual([]);
    expect(w.sweatstack.uploads).toEqual([]);
  });

  it("ignores a ping about an account it doesn't hold", async () => {
    await w.ping(w.garmin.fileReady({ userId: "garmin-stranger", permissions: [] }, "1001"));
    expect(w.garmin.downloads).toEqual([]);
    expect(w.sweatstack.uploads).toEqual([]);
  });

  it.each([
    ["another host", "https://attacker.test/file"],
    ["plain http", "http://apis.garmin.com/file"],
    ["a look-alike host", "https://apis.garmin.com.attacker.test/file"],
    ["another port", "https://apis.garmin.com:8443/file"],
    ["credentials in the address", "https://user:pass@apis.garmin.com/file"],
    ["no address at all", "not a url"],
  ])("never sends a token to %s, whatever the ping says", async (_name, callbackURL) => {
    await w.ping(w.garmin.fileReady(kari, "1001", { callbackURL }));
    expect(w.foreignCalls).toEqual([]);
    expect(w.garmin.downloads).toEqual([]);
    expect(w.sweatstack.uploads).toEqual([]);
  });

  it("doesn't download a file the athlete didn't allow", async () => {
    const other = { userId: "garmin-other", permissions: ["HISTORICAL_DATA_EXPORT"] };
    await w.signIn(client, other);
    await w.ping(w.garmin.fileReady(other, "1001"));
    expect(w.garmin.downloads).toEqual([]);
    expect(w.sweatstack.uploads).toEqual([]);
  });

  describe("the webhook itself", () => {
    it("answers 404 to a wrong secret, and stores nothing", async () => {
      const response = await w.webhook("activity-files", { activityFiles: [w.garmin.fileReady(kari, "1001")] }, { secret: "not-the-secret" });
      expect(response.status).toBe(404);
      await w.settled();
      expect(w.sweatstack.uploads).toEqual([]);
    });

    it("answers 404 to a kind it doesn't take", async () => {
      expect((await w.webhook("no-such-kind", {})).status).toBe(404);
    });

    it("answers 400 to a body that isn't JSON", async () => {
      expect((await w.webhook("activity-files", "nonsense")).status).toBe(400);
    });

    it("acknowledges a body with nothing it can use", async () => {
      expect((await w.webhook("activity-files", { other: [] })).status).toBe(200);
      expect((await w.webhook("activity-files", { activityFiles: [{ userId: "x" }] })).status).toBe(200);
    });
  });
});

describe("when something fails along the way", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  const setUp = async (options: Parameters<typeof world>[0] = {}) => {
    await resetDatabase({ withSigningKey: true });
    w = world(options);
    client = await w.register();
    await w.signIn(client, kari);
  };

  beforeEach(() => setUp());

  const nextMinute = async (minutes = 1) => {
    w.clock.now += minutes * 60;
    await w.cron();
  };

  it("retries a download the platform couldn't serve, on the next run", async () => {
    w.garmin.failures.file.push(503);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.sweatstack.uploads).toEqual([]);
    await nextMinute();
    expect(w.sweatstack.uploads).toHaveLength(1);
  });

  it("backs off between retries", async () => {
    w.garmin.failures.file.push(503, 503, 503);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    await nextMinute();
    expect(w.garmin.downloads).toHaveLength(2);
    await nextMinute();
    expect(w.garmin.downloads).toHaveLength(2);
    await nextMinute();
    expect(w.garmin.downloads).toHaveLength(3);
  });

  it("gives up on a file the platform says is gone", async () => {
    w.garmin.failures.file.push(404);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    await nextMinute(120);
    expect(w.garmin.downloads).toHaveLength(1);
  });

  it("retries an upload SweatStack couldn't take, and the id makes that safe", async () => {
    let failures = 1;
    await setUp({
      intercept: (request) => {
        if (new URL(request.url).pathname.endsWith("/upload") && failures > 0) {
          failures -= 1;
          return new Response(null, { status: 503 });
        }
        return undefined;
      },
    });
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.sweatstack.uploads).toEqual([]);
    await nextMinute();
    expect(w.sweatstack.uploads).toHaveLength(1);
  });

  it("doesn't retry a file SweatStack refused", async () => {
    w.sweatstack.refusedFiles.add("1001");
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.sweatstack.uploads).toHaveLength(1);
    await nextMinute(120);
    expect(w.sweatstack.uploads).toHaveLength(1);
    expect(w.garmin.downloads).toHaveLength(1);
  });

  it("doesn't retry when the user's token lacks activities:write: more attempts can't help", async () => {
    await setUp({ sweatstack: { defaultScopes: [] } });
    await w.ping(w.garmin.fileReady(kari, "1001"));
    await nextMinute(120);
    expect(w.garmin.downloads).toHaveLength(1);
    expect(w.sweatstack.uploads).toEqual([]);
  });

  it("gets a new user token when the user's grant has grown since the cached one was minted", async () => {
    await setUp({ sweatstack: { defaultScopes: [] } });
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.sweatstack.uploads).toEqual([]);

    const [userId] = w.sweatstack.users.keys();
    w.sweatstack.growGrant(userId as string, ["activities:write"]);
    await w.ping(w.garmin.fileReady(kari, "1002"));
    expect(w.sweatstack.uploads.map((upload) => upload.externalId)).toEqual(["1002"]);
  });

  it("gets a new user token when SweatStack stops accepting the cached one", async () => {
    let refused = false;
    await setUp({
      intercept: (request) => {
        if (new URL(request.url).pathname.endsWith("/upload") && !refused) {
          refused = true;
          return new Response(null, { status: 401 });
        }
        return undefined;
      },
    });
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.sweatstack.uploads).toHaveLength(1);
  });

  it("reuses a user token for the next file", async () => {
    await w.ping(w.garmin.fileReady(kari, "1001"));
    await w.ping(w.garmin.fileReady(kari, "1002"));
    expect(w.sweatstack.uploads).toHaveLength(2);
    expect(w.sweatstack.calls.filter((call) => call.path.endsWith("/token") && call.path.includes("/users/"))).toHaveLength(1);
  });
});

describe("a file that arrives before the user is known", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
  });

  it("uploads nothing until SweatStack names the user, then uploads at once", async () => {
    const user = w.sweatstack.createUser({});
    const flow = await w.consent(client, kari, { startedBy: user.id });
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.sweatstack.uploads).toEqual([]);

    const response = await w.exchange(client, { code: flow.code as string, redirect_uri: w.sweatstack.redirectUri(), code_verifier: flow.verifier });
    const { id_token: idToken } = (await response.json()) as { id_token: string };
    const { sub } = await w.verifyIdToken(client, idToken, flow.nonce);
    w.hooks.onSleep = () => w.sweatstack.browserReturns(flow.state, sub as string, { session: user.id });
    await w.settled();

    expect(w.sweatstack.uploads).toEqual([expect.objectContaining({ userId: user.id, externalId: "1001" })]);
  });

  it("uploads nothing, ever, for a link someone else's browser followed", async () => {
    const starter = w.sweatstack.createUser({});
    await w.signIn(client, kari, { startedBy: starter.id });
    await w.settled();
    await w.ping(w.garmin.fileReady(kari, "1001"));
    w.clock.now += 3600;
    await w.cron();
    expect(w.sweatstack.uploads).toEqual([]);
  });
});

describe("what the owner's Garmin app offers", () => {
  beforeEach(() => resetDatabase({ withSigningKey: true }));

  it("doesn't ask anyone to reconnect for what the app can't request", async () => {
    const w = world({ settings: { GARMIN_APP_OFFERS: "activities" } });
    const { sub } = await w.signIn(await w.register(), { userId: "garmin-kari", permissions: ["ACTIVITY_EXPORT"] });
    expect(w.sweatstack.connections.get(sub)?.capabilities).toEqual({
      activities: "ready",
      activity_history: "unavailable",
      wellness: "unavailable",
      workouts: "unavailable",
    });
  });

  it("does ask when the app offers it and the athlete left it off", async () => {
    const w = world({ settings: { GARMIN_APP_OFFERS: "activities,activity_history" } });
    const { sub } = await w.signIn(await w.register(), { userId: "garmin-kari", permissions: ["ACTIVITY_EXPORT"] });
    expect(w.sweatstack.connections.get(sub)?.capabilities).toMatchObject({ activity_history: "action_required" });
  });

  it("answers 503 for a setting that names something that doesn't exist", async () => {
    const w = world({ settings: { GARMIN_APP_OFFERS: "activities,histories" } });
    expect((await w.request("/oidc/garmin_connect/.well-known/openid-configuration")).status).toBe(503);
  });

  it("tells SweatStack again when the owner changes it", async () => {
    const before = world({ settings: { GARMIN_APP_OFFERS: "activities" } });
    const client = await before.register();
    await before.cron();
    const { sub } = await before.signIn(client, { userId: "garmin-kari", permissions: ["ACTIVITY_EXPORT"] });
    expect(before.sweatstack.connections.get(sub)?.capabilities).toMatchObject({ activity_history: "unavailable" });

    // The new setting reaches the same database: the app now can ask, so reconnecting would help.
    const after = world({ settings: { GARMIN_APP_OFFERS: "activities,activity_history" } });
    after.clock.now = before.clock.now;
    await after.cron();
    expect(after.sweatstack.connections.get(sub)?.capabilities).toMatchObject({ activity_history: "action_required" });
  });
});
