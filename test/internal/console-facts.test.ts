import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { gatherFacts } from "../../src/console/facts";
import { LATEST_RELEASE_URL } from "../../src/console/releases";
import { ALL_PERMISSIONS, ORIGIN, PROVIDER, resetDatabase, world, type WorldOptions } from "../support/world";

/** What the console reads, from a real bridge between the fakes. */

const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };
const DAY = 24 * 60 * 60;

let w: ReturnType<typeof world>;
const facts = () => gatherFacts(w.deps, ORIGIN);

/** GitHub's answer for the latest release, counted. */
const github = (answer: () => Response) => {
  const calls: string[] = [];
  const elsewhere: WorldOptions["elsewhere"] = (request) => {
    if (request.url !== LATEST_RELEASE_URL) return undefined;
    calls.push(request.headers.get("User-Agent") ?? "");
    return answer();
  };
  return { calls, elsewhere };
};

beforeEach(async () => {
  await resetDatabase({ withSigningKey: true });
  await env.DB.prepare("DELETE FROM meta WHERE key = 'latest_release'").run();
  w = world();
});

describe("the console's facts", () => {
  it("on a fresh deploy: nothing seen, nothing registered, every count zero", async () => {
    const read = await facts();
    expect(read).toMatchObject({
      origin: ORIGIN,
      version: packageJson.version,
      settingProblems: [],
      sweatstack: { url: w.sweatstack.url, clientId: w.sweatstack.appId },
      credentials: { accepted: true },
      platform: { name: PROVIDER, missingSettings: [], lastConsent: null, registeredAt: null, webhookSecret: expect.stringMatching(/^[0-9a-f]{64}$/) },
      activity: { connections: { total: 0, waitingForUser: 0, needsReconnect: 0 }, waiting: [], failures: [], lastFile: null, lastWellness: null, signingKey: true },
    });
    expect(read.platform.lastPush.size).toBe(0);
  });

  it("sees SweatStack register, a sign-in, and each kind of push", async () => {
    const client = await w.register();
    const registeredAt = w.clock.now;
    w.clock.now += 10;
    await w.signIn(client, kari);
    await w.settled();
    w.clock.now += 10;
    await w.ping(w.garmin.fileReady(kari, "1001"));

    const read = await facts();
    expect(read.platform).toMatchObject({ registeredAt, lastConsent: registeredAt + 10 });
    expect(Object.fromEntries(read.platform.lastPush)).toEqual({ "activity-files": registeredAt + 20 });
    expect(read.activity.connections.total).toBe(1);
    expect(read.activity.lastFile).toBe(registeredAt + 20);
  });

  it("names what's missing, and checks nothing at SweatStack without its settings", async () => {
    w = world({ settings: { GARMIN_CLIENT_SECRET: "", SWEATSTACK_CLIENT_ID: "" } });
    const read = await facts();
    expect(read.settingProblems).toEqual(expect.arrayContaining(["SWEATSTACK_CLIENT_ID is not set", "GARMIN_CLIENT_SECRET is not set"]));
    expect(read.platform.missingSettings).toEqual(["GARMIN_CLIENT_SECRET"]);
    expect(read.sweatstack).toBeNull();
    expect(read.credentials).toBeNull();
  });

  it("checks SweatStack's credentials even when only the platform's settings are missing", async () => {
    w = world({ settings: { GARMIN_CLIENT_ID: "" } });
    expect((await facts()).credentials).toEqual({ accepted: true });
  });

  it("hears SweatStack refuse a wrong secret", async () => {
    w = world({ settings: { SWEATSTACK_CLIENT_SECRET: "not-the-secret" } });
    expect((await facts()).credentials).toEqual({ accepted: false, status: 401 });
  });

  it("says when SweatStack doesn't answer", async () => {
    w = world({ intercept: () => Promise.reject(new TypeError("network down")) });
    expect((await facts()).credentials).toEqual({ accepted: false, status: null });
  });

  it("reads what the app offers, and the platform's guide", async () => {
    w = world({ settings: { GARMIN_APP_OFFERS: "activities,wellness" } });
    const read = await facts();
    expect([...read.platform.offers].sort()).toEqual(["activities", "wellness"]);
    expect(read.platform.guide.name).toBe("Garmin");
  });
});

describe("the latest release", () => {
  it("asks GitHub once a day, as the bridge, and remembers what it said", async () => {
    const gh = github(() => Response.json({ tag_name: "v9.1.0" }));
    w = world({ elsewhere: gh.elsewhere });
    expect((await facts()).latestRelease).toBe("v9.1.0");
    w.clock.now += DAY - 1;
    expect((await facts()).latestRelease).toBe("v9.1.0");
    expect(gh.calls).toEqual(["sweatstack-bridge"]);
    w.clock.now += 1;
    await facts();
    expect(gh.calls).toHaveLength(2);
  });

  it("is null when there's no release yet", async () => {
    w = world({ elsewhere: github(() => new Response("{}", { status: 404 })).elsewhere });
    expect((await facts()).latestRelease).toBeNull();
  });

  it.each([
    ["an error", () => new Response("", { status: 500 })],
    ["a tag that isn't a release", () => Response.json({ tag_name: "nightly" })],
    ["no answer", () => Promise.reject(new TypeError("network down")) as never],
  ])("is unknown after %s, and doesn't ask again that day", async (_, answer) => {
    const gh = github(answer);
    w = world({ elsewhere: gh.elsewhere });
    expect((await facts()).latestRelease).toBeUndefined();
    w.clock.now += 60;
    expect((await facts()).latestRelease).toBeUndefined();
    expect(gh.calls).toHaveLength(1);
  });
});
