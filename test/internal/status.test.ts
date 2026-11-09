import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { missingSettings, STATUS_QUERIES, statusReport } from "../../scripts/lib/status.mjs";
import { ALL_PERMISSIONS, resetDatabase, world, type Client } from "../support/world";

const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };
const lars = { userId: "garmin-lars", permissions: ALL_PERMISSIONS };
const DAY = 24 * 60 * 60;

async function readDatabase() {
  const entries = await Promise.all(Object.entries(STATUS_QUERIES).map(async ([name, query]) => [name, (await env.DB.prepare(query).all()).results]));
  return Object.fromEntries(entries);
}

const facts = {
  name: "my-bridge",
  version: "0.1.0",
  latest: "v0.1.0",
  origin: "https://bridge.test",
  originProblem: null,
  answer: 200,
  settings: { secrets: [], vars: [] },
  sweatstackUrl: "https://app.sweatstack.no",
  sweatstackKeys: true,
  databaseProblem: null,
};
const report = async (extra: object = {}) => statusReport({ ...facts, database: await readDatabase(), ...extra });

describe("npm run status", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
  });

  it("counts connections and says what's quiet", async () => {
    const text = await report();
    expect(text).toContain("Connections: none");
    expect(text).toContain("Jobs:        nothing waiting");
    expect(text).toContain("Failures:    none");
    expect(text).toContain("Last file:   none");
    expect(text).toContain("RUNBOOK.md");
  });

  it("counts who's connected, who's waiting for a user, and who needs a reconnect", async () => {
    await w.signIn(client, kari);
    await w.settled();
    const starter = w.sweatstack.createUser({});
    await w.signIn(client, lars, { startedBy: starter.id });
    await w.settled();
    expect(await report()).toContain("garmin_connect: 2, of which 1 waiting for a user and 0 needing a reconnect");

    w.garmin.revokeEverything();
    await env.DB.prepare("UPDATE connections SET needs_reconnect = 1 WHERE user_id IS NOT NULL").run();
    expect(await report()).toContain("and 1 needing a reconnect");
  });

  it("shows the last file, and what's waiting with why", async () => {
    await w.signIn(client, kari);
    await w.settled();
    w.garmin.failures.file.push(503);
    await w.ping(w.garmin.fileReady(kari, "1"));
    const text = await report();
    expect(text).toContain(`Last file:   ${new Date(w.clock.now * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    expect(text).toContain("Jobs:        1 waiting");
    expect(text).toContain("activity_file: 1, last try: platform_503");
  });

  it("names a failure with its fix: the app no longer has activities:write", async () => {
    await w.signIn(client, kari);
    await w.settled();
    w.sweatstack.defaultScopes = [];
    await env.DB.prepare("DELETE FROM tokens").run();
    await w.ping(w.garmin.fileReady(kari, "1"));
    const text = await report();
    expect(text).toContain("activity_file: sweatstack_400, 1 time");
    expect(text).toContain("Tick write for Activities");
  });

  it("names a failure with its fix: the app hasn't ticked write for Wellness", async () => {
    w = world({ settings: { GARMIN_APP_OFFERS: "activities,activity_history,wellness" } });
    client = await w.register();
    const ines = { userId: "garmin-ines", permissions: [...ALL_PERMISSIONS, "HEALTH_EXPORT"] };
    await w.signIn(client, ines);
    await w.settled();
    await w.webhook("dailies", { dailies: [{ userId: ines.userId, calendarDate: "2026-11-08", restingHeartRateInBeatsPerMinute: 52 }] });
    await w.settled();
    const text = await report({ wellnessOffered: true });
    expect(text).toContain("wellness: sweatstack_400, 1 time");
    expect(text).toContain("Tick write for Wellness");
    expect(text).toContain(`Last wellness: ${new Date(w.clock.now * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`);
  });

  it("says when no wellness has arrived, only for an app that offers it", async () => {
    expect(await report()).not.toContain("Last wellness");
    expect(await report({ wellnessOffered: true })).toContain("Last wellness: none on record. If you expect some, see RUNBOOK.md: Wellness");
  });

  it("leaves out everything that isn't safe to share", async () => {
    const { sub } = await w.signIn(client, kari);
    await w.settled();
    await w.ping(w.garmin.fileReady(kari, "1"));
    const row = await env.DB.prepare("SELECT user_id, access_token, refresh_token FROM connections").first<Record<string, string>>();
    const meta = await env.DB.prepare("SELECT value FROM meta").all<{ value: string }>();
    const text = `${await report()}${JSON.stringify(await readDatabase())}`;
    for (const secret of [sub, row?.user_id, row?.access_token, row?.refresh_token, kari.userId, ...meta.results.map(({ value }) => value)]) {
      expect(text).not.toContain(secret);
    }
  });

  it("says when the signing key is missing", async () => {
    expect(await report()).not.toContain("Signing key");
    await resetDatabase({ withSigningKey: false });
    expect(await report()).toContain("Signing key: missing");
  });

  it("forgets a failure with its job, after 30 days", async () => {
    await w.signIn(client, kari);
    await w.settled();
    w.garmin.failures.file.push(410);
    await w.ping(w.garmin.fileReady(kari, "1"));
    expect(await report()).toContain("activity_file: platform_410");
    w.clock.now += 31 * DAY;
    await w.cron();
    expect(await report()).toContain("Failures:    none");
  });
});

describe("the rest of the report", () => {
  beforeEach(() => resetDatabase({ withSigningKey: true }));

  it.each([
    [{ latest: "v0.2.0" }, "Version:     0.1.0, and v0.2.0 is available: npm run update"],
    [{ latest: "v0.1.0" }, "Version:     0.1.0 (the latest)"],
    [{ latest: null }, "Version:     0.1.0 (no releases yet)"],
    [{ latest: undefined }, "couldn't check for a newer release"],
    [{ answer: null }, "nothing answers there"],
    [{ answer: 404 }, "answers 404, so the bridge isn't there"],
    [{ answer: 503 }, "one of its settings isn't valid"],
    [{ answer: 503, settings: { secrets: ["GARMIN_CLIENT_ID"], vars: [] } }, "normal until its settings are complete"],
    [{ origin: null, originProblem: "Run npx wrangler login first." }, "Address:     unknown. Run npx wrangler login first."],
    [{ sweatstackKeys: false }, "doesn't answer with SweatStack's keys"],
    [{ database: null, databaseProblem: "none yet: the first deploy makes it" }, "Database:    none yet"],
  ])("%o", async (extra, expected) => {
    expect(await report(extra)).toContain(expected);
  });

  it("names each missing setting, with how to set it", () => {
    const settings = missingSettings({ requiredSecrets: ["A_SECRET", "B_SECRET"], secretNames: ["A_SECRET"], vars: { SWEATSTACK_URL: "https://x" } });
    expect(settings).toEqual({ secrets: ["B_SECRET"], vars: ["GARMIN_APP_OFFERS"] });
    const text = statusReport({ ...facts, settings, database: null, databaseProblem: "x" });
    expect(text).toContain("B_SECRET: npx wrangler secret put B_SECRET");
    expect(text).toContain("GARMIN_APP_OFFERS: set it under vars in wrangler.jsonc");
  });

  it("can't name missing secrets before the first deploy", () => {
    const settings = missingSettings({ requiredSecrets: ["A_SECRET"], secretNames: null, vars: {} });
    expect(statusReport({ ...facts, settings, database: null, databaseProblem: "x" })).toContain("can't be read until the first deploy");
  });
});
