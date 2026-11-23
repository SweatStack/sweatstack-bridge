import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { advance, calendarDay, moveOn, newWalk, validTimeZone, walkSteps, type Walk } from "../../src/console/verification";
import type { WalkProgress } from "../../src/db";
import { garmin } from "../../src/providers/garmin";
import type { Account } from "../fakes/garmin";
import { ORIGIN, pathOf, resetDatabase, world } from "../support/world";

/**
 * The walk through Garmin's partner verification, in the console: each step moves on by itself once its data
 * reaches the bridge, and the place survives a closed tab or a night.
 */

const HOUR = 60 * 60;
const NOW = 1_800_000_000;
const EVERYTHING = ["ACTIVITY_EXPORT", "HISTORICAL_DATA_EXPORT", "HEALTH_EXPORT"];
const accountA: Account = { userId: "garmin-a", permissions: EVERYTHING };
const accountB: Account = { userId: "garmin-b", permissions: EVERYTHING };

const guide = garmin({ env: {} as never, fetch, now: () => NOW }).guide.verification!;
const WITH_WELLNESS = walkSteps(guide, new Set(["activities", "wellness"]));
const WITHOUT = walkSteps(guide, new Set(["activities", "activity_history"]));

const nothing = (): WalkProgress => ({ connected: new Set(), jobs: [], flow: null });
const at = (step: string, extra: Partial<Walk> = {}): Walk => ({ ...newWalk(WITH_WELLNESS, NOW, "UTC"), step, ...extra });

describe("the walk's steps", () => {
  it("without wellness: two accounts, an activity each, a permission, a removal and the tests", () => {
    expect(WITHOUT.map((step) => step.id)).toEqual(["connect_a", "activity_a", "connect_b", "activity_b", "permission_b", "remove_b", "tests"]);
  });

  it("with wellness, a weight and a night come last before the tests, so the night is the only wait", () => {
    expect(WITH_WELLNESS.map((step) => step.id).slice(-3)).toEqual(["weight_a", "night_a", "tests"]);
  });

  it("asks for an activity entered by hand: no file to import", () => {
    const activity = WITHOUT.find((step) => step.id === "activity_a");
    expect(activity?.instructions.join(" ")).toContain("add a manual activity");
  });
});

describe("moving the walk on", () => {
  it("records the account that signed in, and when, then waits for its activity", () => {
    const walk = at("connect_a", { flow: { id: "f", expiresAt: NOW + HOUR } });
    const next = advance(walk, WITHOUT, { ...nothing(), flow: { sub: "sub-a" } }, NOW + 60);
    expect(next).toMatchObject({ step: "activity_a", since: NOW + 60, accounts: { a: "sub-a" }, connectedAt: NOW + 60 });
    expect(next.flow).toBeUndefined();
  });

  it("waits while the link is open and nobody has signed in", () => {
    const walk = at("connect_a", { flow: { id: "f", expiresAt: NOW + HOUR } });
    expect(advance(walk, WITHOUT, { ...nothing(), flow: { sub: null } }, NOW + 60)).toEqual(walk);
  });

  it.each([
    ["refused, when the sign-in's row is gone", { flow: null }, NOW + 60, "refused"],
    ["expired, when nobody signed in within the hour", { flow: { sub: null } }, NOW + HOUR, "expired"],
    ["the other account, when it signed in again", { flow: { sub: "sub-a" } }, NOW + 60, "same_account"],
  ] as const)("says the sign-in was %s, and drops the link", (_, progress, now, notice) => {
    const walk = at("connect_b", { accounts: { a: "sub-a" }, flow: { id: "f", expiresAt: NOW + HOUR } });
    const next = advance(walk, WITHOUT, { ...nothing(), connected: new Set(["sub-a"]), ...progress }, now);
    expect(next).toMatchObject({ step: "connect_b", notice });
    expect(next.flow).toBeUndefined();
  });

  it("counts only data that came after the step began", () => {
    const walk = at("permission_b", { accounts: { a: "sub-a", b: "sub-b" }, since: NOW });
    const connected = new Set(["sub-a", "sub-b"]);
    // The permission change a consent queues itself, before this step.
    const before = { ...nothing(), connected, jobs: [{ sub: "sub-b", kind: "permissions_change", at: NOW - 1, measures: [] }] };
    expect(advance(walk, WITHOUT, before, NOW + 60).step).toBe("permission_b");
    const after = { ...nothing(), connected, jobs: [{ sub: "sub-b", kind: "permissions_change", at: NOW + 10, measures: [] }] };
    expect(advance(walk, WITHOUT, after, NOW + 60).step).toBe("remove_b");
  });

  it("counts a day's values only from the owner's calendar day on: history doesn't count", () => {
    const walk = at("night_a", { accounts: { a: "sub-a" }, since: NOW, timeZone: "Europe/Oslo" });
    const night = calendarDay(NOW + 6 * HOUR, "Europe/Oslo");
    const values = (date: string) => [{ measure: "sleep_duration", date }, { measure: "hrv", date }];
    const progress = (date: string): WalkProgress => ({ ...nothing(), connected: new Set(["sub-a"]), jobs: [{ sub: "sub-a", kind: "wellness", at: NOW + 10 * HOUR, measures: values(date) }] });
    expect(advance(walk, WITH_WELLNESS, progress("2026-01-01"), NOW + 10 * HOUR).step).toBe("night_a");
    expect(advance(walk, WITH_WELLNESS, progress(night), NOW + 10 * HOUR).step).toBe("tests");
  });

  it("moves through every step whose data has already come, at once", () => {
    const walk = at("activity_b", { accounts: { a: "sub-a", b: "sub-b" }, since: NOW });
    const progress = { ...nothing(), connected: new Set(["sub-a"]), jobs: [{ sub: "sub-b", kind: "activity_file", at: NOW + 1, measures: [] }] };
    // The activity came; the permission and removal steps begin now, so B's earlier removal doesn't skip the permission.
    expect(advance(walk, WITHOUT, progress, NOW + 5).step).toBe("permission_b");
  });

  it("starts again once the bridge has ended account A's connection, but not at the tests", () => {
    const progress = { ...nothing(), connected: new Set<string>() };
    expect(advance(at("activity_b", { accounts: { a: "sub-a", b: "sub-b" } }), WITHOUT, progress, NOW + 25 * HOUR)).toMatchObject({
      step: "connect_a",
      accounts: {},
      notice: "connection_ended",
    });
    expect(advance(at("tests", { accounts: { a: "sub-a" } }), WITHOUT, progress, NOW + 25 * HOUR).step).toBe("tests");
  });

  it("waits at the tests until the owner says they passed, and is done then", () => {
    const walk = at("tests", { accounts: { a: "sub-a" } });
    expect(advance(walk, WITHOUT, { ...nothing(), connected: new Set(["sub-a"]) }, NOW + 60).step).toBe("tests");
    expect(moveOn(walk, WITHOUT, NOW + 60).finishedAt).toBe(NOW + 60);
  });
});

describe("the owner's time zone", () => {
  it("dates a day as the owner's calendar does", () => {
    // 2027-01-15 23:30 UTC is already the 16th in Oslo.
    const late = Date.UTC(2027, 0, 15, 23, 30) / 1000;
    expect(calendarDay(late, "UTC")).toBe("2027-01-15");
    expect(calendarDay(late, "Europe/Oslo")).toBe("2027-01-16");
  });

  it("falls back to UTC for a time zone the runtime doesn't know", () => {
    expect(validTimeZone("Europe/Oslo")).toBe("Europe/Oslo");
    expect(validTimeZone("Mars/Olympus")).toBe("UTC");
    expect(newWalk(WITHOUT, NOW, "nonsense").timeZone).toBe("UTC");
  });
});

describe("the walk in the console", () => {
  let w: ReturnType<typeof world>;
  let cookie: string;

  const post = (path: string, fields: Record<string, string>) =>
    w.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
      body: new URLSearchParams(fields).toString(),
    });
  const walkPage = async () => (await (await w.request("/console/verification", { headers: { Cookie: cookie } })).text()).replaceAll("&#39;", "'");
  const act = (action: string, extra: Record<string, string> = {}) => post("/console/verification", { action, ...extra });

  /** The owner opening the link in a private window and allowing everything. Returns where it lands. */
  const signInWith = async (account: Account) => {
    const link = /value="([^"]+\/start\/garmin_connect\/[^"]+)"/.exec(await walkPage())?.[1] as string;
    const started = await w.request(pathOf(link));
    const back = await w.request(pathOf(w.garmin.approve(started.headers.get("Location") as string, account)));
    await w.settled();
    return new URL(back.headers.get("Location") as string);
  };

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    await env.DB.prepare("DELETE FROM meta WHERE key = 'verification'").run();
    w = world({ sweatstack: { selfHosted: false } });
    cookie = "";
    const signIn = await post("/console/sign-in", { secret: w.sweatstack.clientSecret });
    cookie = (signIn.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
  });

  it("goes from start to Garmin's tests, each step moving on as its data arrives", async () => {
    expect(await walkPage()).toContain("Start the walk");
    await act("start", { timeZone: "Europe/Oslo" });
    expect(await walkPage()).toContain("Step 1 of 7");

    await act("link");
    expect(await walkPage()).toContain('<meta http-equiv="refresh" content="15"');
    const landing = await signInWith(accountA);
    expect(landing.pathname).toBe("/console/verification/connected");
    expect(await walkPage()).toContain("Step 2 of 7");

    await w.ping(w.garmin.fileReady(accountA, "manual-a"));
    expect(await walkPage()).toContain("Step 3 of 7");

    await act("link");
    await signInWith(accountB);
    expect(await walkPage()).toContain("Step 4 of 7");

    await w.ping(w.garmin.fileReady(accountB, "manual-b"));
    w.clock.now += 1;
    await w.notify("user-permissions", w.garmin.permissionsChanged(accountB, ["ACTIVITY_EXPORT"]));
    expect(await walkPage()).toContain("Step 6 of 7");

    // A deregistration ends only a consent older than itself.
    w.clock.now += 60;
    await w.notify("deregistrations", w.garmin.deregistration(accountB));
    const tests = await walkPage();
    expect(tests).toContain("Step 7 of 7");
    expect(tests).not.toContain('http-equiv="refresh"');

    await act("passed");
    expect(await walkPage()).toContain("The walk is done");
    const console = (await (await w.request("/console", { headers: { Cookie: cookie } })).text()).replaceAll("&#39;", "'");
    expect(console).toContain("Garmin's tests passed");
  });

  it("gives a new link, and says when Garmin didn't connect the account", async () => {
    await act("start");
    await act("link");
    const first = await walkPage();
    const started = await w.request(pathOf(/value="([^"]+\/start\/garmin_connect\/[^"]+)"/.exec(first)?.[1] as string));
    const back = await w.request(pathOf(w.garmin.deny(started.headers.get("Location") as string)));
    expect(new URL(back.headers.get("Location") as string).searchParams.get("error")).toBe("access_denied");
    const page = await walkPage();
    expect(page).toContain("wasn't connected");
    expect(page).toContain("Get a sign-in link");
  });

  it("lets the owner skip a check, and says the tests will show it", async () => {
    await act("start");
    await act("link");
    await signInWith(accountA);
    await act("skip");
    const page = await walkPage();
    expect(page).toContain("Step 3 of 7");
    expect(page).toContain("Skipped.");
  });

  it("starts over when asked", async () => {
    await act("start");
    await act("restart");
    expect(await walkPage()).toContain("Start the walk");
  });

  it("is only for the signed-in owner", async () => {
    cookie = "";
    const page = await w.request("/console/verification");
    expect(page.status).toBe(302);
    expect((await act("start")).headers.get("Location")).toBe("/console");
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key = 'verification'").first()).toBeNull();
  });

  it("lands the private window on a page that says nothing about the bridge", async () => {
    for (const path of ["/console/verification/connected", "/console/verification/connected?error=access_denied"]) {
      const response = await w.request(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Close this window");
      expect(html).not.toMatch(/garmin_connect|Sign out|\/start\//);
    }
  });
});
