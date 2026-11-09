import { beforeEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/garmin/wellness.json";
import type { Account } from "../fakes/garmin";
import { resetDatabase, world, type Client } from "../support/world";

const EVERYTHING = ["ACTIVITY_EXPORT", "HISTORICAL_DATA_EXPORT", "HEALTH_EXPORT"];
const kari: Account = { userId: "garmin-kari", permissions: EVERYTHING };

/** Garmin's list key for each summary type, and the path the owner pasted for it. */
const URL_OF: Record<string, string> = { dailies: "dailies", sleeps: "sleeps", bodyComps: "body-compositions", hrv: "hrv" };

const WELLNESS_APP = {
  settings: { GARMIN_APP_OFFERS: "activities,activity_history,wellness" },
  sweatstack: { defaultScopes: ["activities:write", "wellness:write"] },
};

type Options = Parameters<typeof world>[0];

const sorted = <T extends { measure: string; date: string }>(rows: T[]) =>
  [...rows].sort((a, b) => `${a.measure} ${a.date}`.localeCompare(`${b.measure} ${b.date}`));

/** Contract: "Upload data", for dailies. What SweatStack sees of a push, from Garmin to the daily route. */
describe("relaying wellness", () => {
  let w: ReturnType<typeof world>;
  let client: Client;
  let userId: string;

  const setUp = async (options: Options = WELLNESS_APP, account: Account = kari) => {
    await resetDatabase({ withSigningKey: true });
    w = world(options);
    client = await w.register();
    const { sub } = await w.signIn(client, account);
    await w.settled();
    userId = w.sweatstack.connections.get(sub)?.userId as string;
  };

  /** Garmin pushing one list of summaries for an account, and everything it set off. */
  const push = async (summaryType: string, summaries: object[], account: Account = kari) => {
    const response = await w.webhook(URL_OF[summaryType] as string, { [summaryType]: summaries.map((summary) => ({ ...summary, userId: account.userId })) });
    await w.settled();
    return response;
  };

  const restingHeartRate = (calendarDate: string, value: number) => ({ summaryId: `x-${calendarDate}`, calendarDate, restingHeartRateInBeatsPerMinute: value });

  const stored = () =>
    sorted(w.sweatstack.dailies(userId)).map(({ measure, date, value, writer, platform }) => ({ measure, date, value, writer, platform }));

  const nextMinute = async (minutes = 1) => {
    w.clock.now += minutes * 60;
    await w.cron();
  };

  beforeEach(() => setUp());

  describe("every shared fixture ends as SweatStack's own Garmin connection stores it", () => {
    it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))("%s", async (_name, fixture) => {
      expect((await push(fixture.summaryType, fixture.summaries)).status).toBe(200);
      expect(stored()).toEqual(sorted(fixture.rows).map((row) => ({ ...row, writer: "application" })));
    });
  });

  it("acknowledges before it writes, so a slow SweatStack can't hold up Garmin", async () => {
    const response = await w.webhook("dailies", { dailies: [{ ...restingHeartRate("2026-11-08", 52), userId: kari.userId }] });
    expect(response.status).toBe(200);
    expect(w.sweatstack.dailyWrites).toEqual([]);
    await w.settled();
    expect(w.sweatstack.dailyWrites).toHaveLength(1);
  });

  it("replaces whatever the day held with Garmin's later value, the athlete's own included", async () => {
    w.sweatstack.storeDaily(userId, { measure: "resting_hr", date: "2026-11-08", value: 49, writer: "athlete", application_id: null, platform: null });
    await push("dailies", [restingHeartRate("2026-11-08", 52)]);
    await push("dailies", [restingHeartRate("2026-11-08", 51)]);
    expect(stored()).toEqual([{ measure: "resting_hr", date: "2026-11-08", value: 51, writer: "application", platform: "garmin_connect" }]);
  });

  it("writes an unchanged value only once at SweatStack's end", async () => {
    await push("dailies", [restingHeartRate("2026-11-08", 52)]);
    await push("dailies", [restingHeartRate("2026-11-08", 52)]);
    expect(w.sweatstack.dailyWrites).toHaveLength(1);
  });

  it("writes a correction after a retry in the order Garmin sent them, so an older value never comes back", async () => {
    let failures = 1;
    await setUp({
      ...WELLNESS_APP,
      intercept: (request) => {
        if (new URL(request.url).pathname.includes("/dailies/") && failures > 0) {
          failures -= 1;
          return new Response(null, { status: 503 });
        }
        return undefined;
      },
    });
    await push("dailies", [restingHeartRate("2026-11-08", 52)]);
    await push("dailies", [restingHeartRate("2026-11-08", 51)]);
    expect(stored()).toEqual([]);
    await nextMinute();
    expect(stored()).toMatchObject([{ value: 51 }]);
  });

  it("asks for one token for wellness and keeps it, apart from the one for files", async () => {
    await push("dailies", [restingHeartRate("2026-11-08", 52)]);
    await push("sleeps", [{ summaryId: "s", calendarDate: "2026-11-08", durationInSeconds: 27000 }]);
    await w.ping(w.garmin.fileReady(kari, "1001"));
    expect(w.sweatstack.mintedScopes).toEqual([["wellness:write"], ["activities:write"]]);
  });

  it("gets a new token when SweatStack stops accepting the cached one", async () => {
    let refused = false;
    await setUp({
      ...WELLNESS_APP,
      intercept: (request) => {
        if (new URL(request.url).pathname.includes("/dailies/") && !refused) {
          refused = true;
          return new Response(null, { status: 401 });
        }
        return undefined;
      },
    });
    await push("dailies", [restingHeartRate("2026-11-08", 52)]);
    expect(stored()).toHaveLength(1);
  });

  it("writes nothing for an account it doesn't hold", async () => {
    await push("dailies", [restingHeartRate("2026-11-08", 52)], { userId: "garmin-stranger", permissions: EVERYTHING });
    expect(w.sweatstack.dailyWrites).toEqual([]);
  });

  it("writes nothing for an athlete who didn't share their health data", async () => {
    await setUp(WELLNESS_APP, { userId: "garmin-kari", permissions: ["ACTIVITY_EXPORT", "HISTORICAL_DATA_EXPORT"] });
    await push("dailies", [restingHeartRate("2026-11-08", 52)]);
    expect(w.sweatstack.dailyWrites).toEqual([]);
  });

  it("writes nothing when the owner's Garmin app doesn't offer wellness", async () => {
    await setUp({ ...WELLNESS_APP, settings: { GARMIN_APP_OFFERS: "activities,activity_history" } });
    await push("dailies", [restingHeartRate("2026-11-08", 52)]);
    expect(w.sweatstack.dailyWrites).toEqual([]);
  });

  it("uses nothing from a ping, which holds a link instead of the values", async () => {
    const response = await w.webhook("sleeps", {
      sleeps: [{ userId: kari.userId, callbackURL: "https://apis.garmin.com/wellness-api/rest/sleeps?uploadStartTimeInSeconds=1&uploadEndTimeInSeconds=2&token=t" }],
    });
    await w.settled();
    expect(response.status).toBe(200);
    expect(w.foreignCalls).toEqual([]);
    expect(w.sweatstack.dailyWrites).toEqual([]);
  });

  it("reads only the summary type its address is for", async () => {
    await w.webhook("sleeps", { dailies: [{ ...restingHeartRate("2026-11-08", 52), userId: kari.userId }] });
    await w.settled();
    expect(w.sweatstack.dailyWrites).toEqual([]);
  });

  it("writes nothing until SweatStack names the user, then writes at once", async () => {
    await resetDatabase({ withSigningKey: true });
    w = world(WELLNESS_APP);
    client = await w.register();
    const user = w.sweatstack.createUser({});
    const flow = await w.consent(client, kari, { startedBy: user.id });
    await push("dailies", [restingHeartRate("2026-11-08", 52)]);
    expect(w.sweatstack.dailyWrites).toEqual([]);

    const response = await w.exchange(client, { code: flow.code as string, redirect_uri: w.sweatstack.redirectUri(), code_verifier: flow.verifier });
    const { id_token: idToken } = (await response.json()) as { id_token: string };
    const { sub } = await w.verifyIdToken(client, idToken, flow.nonce);
    w.hooks.onSleep = () => w.sweatstack.browserReturns(flow.state, sub as string, { session: user.id });
    await w.settled();
    expect(w.sweatstack.dailyWrites).toEqual([expect.objectContaining({ userId: user.id, measure: "resting_hr", value: 52 })]);
  });

  describe("when the app hasn't ticked write for Wellness", () => {
    beforeEach(() => setUp({ ...WELLNESS_APP, sweatstack: { defaultScopes: ["activities:write"] } }));

    it("gives up on wellness, since trying again can't help, and still relays files", async () => {
      await push("dailies", [restingHeartRate("2026-11-08", 52)]);
      await nextMinute(120);
      expect(w.sweatstack.dailyWrites).toEqual([]);
      expect(w.sweatstack.calls.filter((call) => call.path.endsWith("/token") && call.path.includes("/users/"))).toHaveLength(1);

      await w.ping(w.garmin.fileReady(kari, "1001"));
      expect(w.sweatstack.uploads).toHaveLength(1);
    });
  });

  describe("history", () => {
    const DAY = 24 * 60 * 60;

    it("asks for the last 28 days of each summary type when the athlete connects", async () => {
      expect(w.garmin.healthBackfills.map(({ type }) => type).sort()).toEqual(["bodyComps", "dailies", "hrv", "sleeps"]);
      for (const window of w.garmin.healthBackfills) expect(window.end - window.start).toBe(28 * DAY);
    });

    it("says wellness is syncing until it has asked, then ready", async () => {
      await resetDatabase({ withSigningKey: true });
      w = world(WELLNESS_APP);
      w.garmin.failures.healthBackfill.push(503);
      const { sub } = await w.signIn(await w.register(), kari);
      await w.settled();
      expect(w.sweatstack.connections.get(sub)?.capabilities).toMatchObject({ wellness: "syncing" });
      await nextMinute();
      expect(w.sweatstack.connections.get(sub)?.capabilities).toMatchObject({ wellness: "ready" });
    });

    it("asks once", async () => {
      await nextMinute(60);
      expect(w.garmin.healthBackfillRequests).toHaveLength(4);
    });

    it("asks for nothing, and says ready, when the app has no history, as on Garmin's Starter Access", async () => {
      await resetDatabase({ withSigningKey: true });
      w = world({ ...WELLNESS_APP, settings: { GARMIN_APP_OFFERS: "activities,wellness" } });
      const { sub } = await w.signIn(await w.register(), kari);
      await w.settled();
      expect(w.garmin.healthBackfillRequests).toEqual([]);
      expect(w.sweatstack.connections.get(sub)?.capabilities).toMatchObject({ activity_history: "unavailable", wellness: "ready" });
    });

    it("asks for nothing without the athlete's history permission", async () => {
      await setUp(WELLNESS_APP, { userId: "garmin-kari", permissions: ["ACTIVITY_EXPORT", "HEALTH_EXPORT"] });
      expect(w.garmin.healthBackfillRequests).toEqual([]);
    });

    it("asks when the athlete shares their health data later, and asks the athlete to until then", async () => {
      const later: Account = { userId: "garmin-kari", permissions: ["ACTIVITY_EXPORT", "HISTORICAL_DATA_EXPORT"] };
      await setUp(WELLNESS_APP, later);
      const sub = [...w.sweatstack.connections.keys()][0] as string;
      expect(w.garmin.healthBackfillRequests).toEqual([]);
      expect(w.sweatstack.connections.get(sub)?.capabilities).toMatchObject({ wellness: "action_required" });

      later.permissions = EVERYTHING;
      await w.notify("user-permissions", w.garmin.permissionsChanged(later));
      expect(w.garmin.healthBackfills).toHaveLength(4);
      expect(w.sweatstack.connections.get(sub)?.capabilities).toMatchObject({ wellness: "ready" });
    });
  });
});
