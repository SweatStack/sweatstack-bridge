import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { RUNBOOK_SECTION, verificationSignIn } from "../../scripts/lib/verify.mjs";
import type { Account } from "../fakes/garmin";
import { ORIGIN, PROVIDER, pathOf, resetDatabase, world } from "../support/world";

/**
 * A sign-in that `npm run verify` starts for Garmin's partner verification: no SweatStack in front of it,
 * and no user ever named. Everything after the link is what the bridge does for any connection that
 * nobody claims, pinned down here for this use (RUNBOOK.md, Pass Garmin's verification).
 */

const HOUR = 60 * 60;
const EVERYTHING = ["ACTIVITY_EXPORT", "HISTORICAL_DATA_EXPORT", "HEALTH_EXPORT"];
const kari: Account = { userId: "garmin-kari", permissions: EVERYTHING };

/** Before the owner switches the card: SweatStack answers every connection call with 409. */
const BEFORE_THE_SWITCH = { sweatstack: { selfHosted: false }, settings: { GARMIN_APP_OFFERS: "activities,wellness" } };
const AFTER_THE_SWITCH = { settings: { GARMIN_APP_OFFERS: "activities,wellness" } };

let w: ReturnType<typeof world>;

const setUp = async (options: Parameters<typeof world>[0]) => {
  await resetDatabase({ withSigningKey: true });
  w = world(options);
};

/** What `npm run verify` does: the row through the owner's Cloudflare login, and the link it prints. */
const verificationLink = async () => {
  const signIn = verificationSignIn({ now: w.clock.now });
  await env.DB.prepare(signIn.sql).run();
  return signIn;
};

/** The owner opening the link and allowing everything at Garmin. Returns where the browser lands. */
const connect = async (account: Account) => {
  const { path } = await verificationLink();
  const started = await w.request(path);
  expect(started.status).toBe(302);
  const back = await w.request(pathOf(w.garmin.approve(started.headers.get("Location") as string, account)));
  expect(back.status).toBe(302);
  await w.settled();
  return new URL(back.headers.get("Location") as string);
};

const connectionRows = async () => (await env.DB.prepare("SELECT sub, user_id FROM connections").all<{ sub: string; user_id: string | null }>()).results;

const hoursLater = async (hours: number) => {
  w.clock.now += hours * HOUR;
  await w.cron();
};

const pushDailies = (account: Account) =>
  w.webhook("dailies", { dailies: [{ userId: account.userId, summaryId: "x-2026-11-10", calendarDate: "2026-11-10", restingHeartRateInBeatsPerMinute: 48 }] });

describe("a sign-in for Garmin's verification", () => {
  beforeEach(() => setUp(BEFORE_THE_SWITCH));

  it("goes from the bridge's link to Garmin's consent, for this bridge's callback", async () => {
    const { path } = await verificationLink();
    const started = await w.request(path);
    expect(started.status).toBe(302);
    const garmin = new URL(started.headers.get("Location") as string);
    expect(garmin.origin + garmin.pathname).toBe("https://connect.garmin.com/oauth2Confirm");
    expect(garmin.searchParams.get("client_id")).toBe(w.garmin.clientId);
    expect(garmin.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback/${PROVIDER}`);
  });

  it("lands on the runbook's section after Garmin's consent", async () => {
    const landing = await connect(kari);
    expect(landing.origin + landing.pathname + landing.hash).toBe(RUNBOOK_SECTION);
    expect(landing.searchParams.get("error")).toBeNull();
    expect(await connectionRows()).toHaveLength(1);
  });

  it("lands on the runbook's section with the error when the owner refuses at Garmin", async () => {
    const { path } = await verificationLink();
    const started = await w.request(path);
    const back = await w.request(pathOf(w.garmin.deny(started.headers.get("Location") as string)));
    const landing = new URL(back.headers.get("Location") as string);
    expect(landing.origin + landing.pathname + landing.hash).toBe(RUNBOOK_SECTION);
    expect(landing.searchParams.get("error")).toBe("access_denied");
    expect(await connectionRows()).toEqual([]);
  });

  it("works once", async () => {
    const { path } = await verificationLink();
    const started = await w.request(path);
    const callback = pathOf(w.garmin.approve(started.headers.get("Location") as string, kari));
    expect((await w.request(callback)).status).toBe(302);
    expect((await w.request(path)).status).toBe(400);
    expect((await w.request(callback)).status).toBe(400);
  });

  it("works for an hour", async () => {
    const { path, expiresAt } = await verificationLink();
    expect(expiresAt).toBe(w.clock.now + HOUR);
    w.clock.now += HOUR;
    const expired = await w.request(path);
    expect(expired.status).toBe(400);
    expect(await expired.text()).toMatch(/npm run verify/);
  });

  it("refuses a link the bridge never made", async () => {
    expect((await w.request(`/start/${PROVIDER}/made-up`)).status).toBe(400);
  });
});

describe("a Garmin account connected for the verification", () => {
  it("before the switch: nothing reaches SweatStack, and the account goes after a day", async () => {
    await setUp(BEFORE_THE_SWITCH);
    await connect(kari);
    expect(await w.ping(w.garmin.fileReady(kari, "1001"))).toHaveProperty("status", 200);
    expect(await pushDailies(kari)).toHaveProperty("status", 200);
    await w.settled();
    await hoursLater(23);
    expect(w.garmin.downloads).toEqual([]);
    expect(w.sweatstack.uploads).toEqual([]);
    expect(w.sweatstack.dailyWrites).toEqual([]);
    expect(w.garmin.deregistered).toEqual([]);

    await hoursLater(2);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
    expect(await connectionRows()).toEqual([]);
  });

  it("after the switch: SweatStack names no user for it, and the account goes after a day", async () => {
    await setUp(AFTER_THE_SWITCH);
    await w.register();
    await connect(kari);
    const [connection] = await connectionRows();
    expect(connection?.user_id).toBeNull();
    expect(w.sweatstack.connections.get(connection?.sub as string)?.userId).toBeNull();
    await w.ping(w.garmin.fileReady(kari, "1001"));
    await hoursLater(25);
    expect(w.garmin.downloads).toEqual([]);
    expect(w.sweatstack.uploads).toEqual([]);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
    expect(w.sweatstack.connections.has(connection?.sub as string)).toBe(false);
  });

  it("gives no ID token for its code", async () => {
    await setUp(AFTER_THE_SWITCH);
    const client = await w.register();
    const landing = await connect(kari);
    const response = await w.exchange(client, { code: landing.searchParams.get("code") as string, redirect_uri: RUNBOOK_SECTION, code_verifier: "a".repeat(43) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("stays an athlete's connection when the account is already one, with its user", async () => {
    await setUp(AFTER_THE_SWITCH);
    const client = await w.register();
    const { sub } = await w.signIn(client, kari);
    await w.settled();
    const user = w.sweatstack.connections.get(sub)?.userId;
    await connect(kari);
    await hoursLater(25);
    expect(w.garmin.deregistered).toEqual([]);
    expect(await connectionRows()).toEqual([{ sub, user_id: user }]);
  });
});

describe("the warnings", () => {
  let warn: MockInstance<typeof console.warn>;
  const warnings = () => warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
  const named = (event: string) => warnings().filter((warning) => warning.event === event);

  beforeEach(async () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setUp(BEFORE_THE_SWITCH);
  });
  afterEach(() => warn.mockRestore());

  it("say that SweatStack isn't connected when it answers 409, with the fix", async () => {
    await connect(kari);
    expect(named("sweatstack_not_connected")[0]).toMatchObject({ fix: expect.stringMatching(/Self-hosted.*Data sources tab/) });
  });

  it("say once that a file waits for a user, however often its job runs", async () => {
    await connect(kari);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    for (const hours of [1, 2, 4]) await hoursLater(hours);
    expect(named("push_waiting_for_user")).toEqual([{ event: "push_waiting_for_user", provider: PROVIDER, kind: "activity_file" }]);
  });

  it("say once that daily values wait for a user", async () => {
    await connect(kari);
    await pushDailies(kari);
    await w.settled();
    await hoursLater(1);
    expect(named("push_waiting_for_user")).toEqual([{ event: "push_waiting_for_user", provider: PROVIDER, kind: "wellness" }]);
  });

  it("say why a push was refused", async () => {
    expect((await w.webhook("dailies", {}, { secret: "an-old-secret" })).status).toBe(404);
    expect((await w.webhook("epochs", {})).status).toBe(404);
    expect((await w.webhook("dailies", "not json")).status).toBe(400);
    expect(named("webhook_refused")).toEqual([
      { event: "webhook_refused", provider: PROVIDER, reason: "unknown_secret" },
      { event: "webhook_refused", provider: PROVIDER, reason: "unknown_kind", kind: "epochs" },
      { event: "webhook_refused", provider: PROVIDER, reason: "invalid_body" },
    ]);
  });

  it("aren't given for a push that's fine", async () => {
    await connect(kari);
    warn.mockClear();
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(named("webhook_refused")).toEqual([]);
  });
});
