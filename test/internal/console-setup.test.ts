import { describe, expect, it } from "vitest";
import type { Facts } from "../../src/console/facts";
import { banners, cloudflareSettings, notificationRows, pasteValues, setup, sweatstackTab } from "../../src/console/setup";
import { ago, utc } from "../../src/console/time";
import { status } from "../../src/console/status";
import type { Activity } from "../../src/db";
import { garmin } from "../../src/providers/garmin";
import type { Capability } from "../../src/providers/types";

/** What the console says, from the facts alone. */

const NOW = 1_800_000_000;
const provider = garmin({ env: {} as never, fetch, now: () => NOW });
const SECRET = "a".repeat(64);

const quietActivity: Activity = {
  connections: { total: 0, waitingForUser: 0, needsReconnect: 0 },
  waiting: [],
  failures: [],
  lastFile: null,
  lastWellness: null,
  signingKey: true,
};

/** A bridge that was just deployed, with every setting right, and these changes. */
function factsWith({
  offers = ["activities", "activity_history"],
  lastPush = {},
  activity = {},
  ...rest
}: Partial<Omit<Facts, "platform" | "activity">> & {
  offers?: Capability[];
  lastPush?: Record<string, number>;
  activity?: Partial<Activity>;
  lastConsent?: number | null;
  registeredAt?: number | null;
} = {}): Facts {
  const { lastConsent = null, registeredAt = null, ...top } = rest;
  return {
    now: NOW,
    origin: "https://garmin.example.com",
    version: "0.7.0",
    latestRelease: "v0.7.0",
    settingProblems: [],
    sweatstack: { url: "https://app.sweatstack.no", clientId: "app-1" },
    credentials: { accepted: true },
    walk: null,
    ...top,
    platform: {
      name: provider.name,
      guide: provider.guide,
      offers: new Set(offers),
      missingSettings: [],
      webhookSecret: SECRET,
      lastConsent,
      lastPush: new Map(Object.entries(lastPush)),
      registeredAt,
    },
    activity: { ...quietActivity, ...activity },
  };
}

describe("the steps", () => {
  it("on a fresh deploy: three steps left, none proven", () => {
    expect(setup(factsWith())).toEqual({ app: null, notifications: null, verification: null, sweatstack: null, left: 3 });
  });

  it("proves the platform app at the first sign-in", () => {
    expect(setup(factsWith({ lastConsent: NOW - 60 }))).toMatchObject({ app: { at: NOW - 60 }, left: 2 });
  });

  it("proves SweatStack's switch when it registers with the bridge", () => {
    expect(setup(factsWith({ registeredAt: NOW - 5 }))).toMatchObject({ sweatstack: { at: NOW - 5 }, left: 2 });
  });

  it("proves the notifications at the first activity file, without waiting for the settings that need an athlete to act", () => {
    expect(setup(factsWith({ lastPush: { "activity-files": NOW - 30 } }))).toMatchObject({ notifications: { at: NOW - 30 }, left: 2 });
    expect(setup(factsWith({ lastPush: { deregistrations: NOW, "user-permissions": NOW } })).notifications).toBeNull();
  });

  it("with wellness on offer, also waits for Garmin's dailies, but not for what an athlete must record", () => {
    const wellness = { offers: ["activities", "wellness"] as Capability[] };
    expect(setup(factsWith({ ...wellness, lastPush: { "activity-files": NOW - 30 } })).notifications).toBeNull();
    expect(setup(factsWith({ ...wellness, lastPush: { "activity-files": NOW - 30, dailies: NOW - 10 } })).notifications).toEqual({ at: NOW - 10 });
  });

  it("is done when the three that count are proven, whatever the verification", () => {
    const done = setup(factsWith({ lastConsent: NOW, registeredAt: NOW, lastPush: { "activity-files": NOW } }));
    expect(done.left).toBe(0);
    expect(done.verification).toBeNull();
  });
});

describe("the values to paste", () => {
  it("lists the platform's settings in its tool's order, each with its URL and when it last sent", () => {
    const rows = notificationRows(factsWith({ lastPush: { deregistrations: NOW - 1 } }));
    expect(rows.map((row) => [row.setting.label, row.url, row.lastPush])).toEqual([
      ["ACTIVITY - Activity Files", `https://garmin.example.com/garmin_connect/${SECRET}/activity-files`, null],
      ["COMMON - Deregistrations", `https://garmin.example.com/garmin_connect/${SECRET}/deregistrations`, NOW - 1],
      ["COMMON - User Permissions Change", `https://garmin.example.com/garmin_connect/${SECRET}/user-permissions`, null],
    ]);
  });

  it("adds the health settings for an app that offers wellness, and so covers every webhook the platform takes", () => {
    const rows = notificationRows(factsWith({ offers: ["activities", "wellness"] }));
    expect(rows.map((row) => row.setting.webhook).sort()).toEqual([...provider.webhookKinds].sort());
  });

  it("gives the redirect URL and the issuer at the address the owner is on", () => {
    expect(pasteValues(factsWith())).toEqual({
      redirectUrl: "https://garmin.example.com/callback/garmin_connect",
      issuer: "https://garmin.example.com/oidc/garmin_connect",
    });
  });

  it("describes every capability the platform has", () => {
    expect(Object.keys(provider.guide.capabilities).sort()).toEqual(["activities", "activity_history", "wellness", "workouts"]);
  });
});

describe("the banners", () => {
  it("are none on a healthy bridge", () => {
    expect(banners(factsWith())).toEqual([]);
  });

  it("come in the order to fix them", () => {
    const found = banners(
      factsWith({
        latestRelease: "v0.8.0",
        settingProblems: ["GARMIN_CLIENT_SECRET is not set"],
        credentials: { accepted: false, status: 401 },
        activity: { signingKey: false, failures: [{ kind: "activity_file", reason: "sweatstack_403", count: 3, latest: NOW }] },
      }),
    );
    expect(found.map((banner) => banner.kind)).toEqual(["settings", "signing_key", "credentials", "failure", "release"]);
  });

  it.each([
    ["activity_file", "sweatstack_400", "consent", "Tick write for Activities"],
    ["activity_file", "sweatstack_403", "consent", "Tick write for Activities"],
    ["wellness", "sweatstack_403", "consent", "Tick write for Wellness"],
    ["declare", "sweatstack_409", "data-sources", "Set Garmin to Self-hosted"],
    ["declare", "sweatstack_403", "data-sources", "Garmin is set to Self-hosted"],
  ] as const)("give the fix for %s %s, on SweatStack's %s tab", (kind, reason, tab, text) => {
    const [banner] = banners(factsWith({ activity: { failures: [{ kind, reason, count: 2, latest: NOW }] } }));
    expect(banner).toMatchObject({ kind: "failure", count: 2, tab, fix: expect.stringContaining(text) });
  });

  it("leave out a failure with no known fix: retrying is all there is", () => {
    expect(banners(factsWith({ activity: { failures: [{ kind: "activity_file", reason: "download_failed", count: 1, latest: NOW }] } }))).toEqual([]);
  });

  it.each([
    ["v0.7.1", true],
    ["v0.8.0", true],
    ["v1.0.0", true],
    ["v0.7.0", false],
    ["v0.6.9", false],
    [null, false],
    [undefined, false],
  ])("offer the release %s: %s", (latest, offered) => {
    expect(banners(factsWith({ latestRelease: latest })).some((banner) => banner.kind === "release")).toBe(offered);
  });

  it("say SweatStack didn't answer, apart from refusing", () => {
    expect(banners(factsWith({ credentials: { accepted: false, status: null } }))).toEqual([{ kind: "credentials", status: null }]);
  });
});

describe("the status", () => {
  it("adds up the counts, and mentions wellness only for an app that offers it", () => {
    const activity: Partial<Activity> = {
      connections: { total: 214, waitingForUser: 1, needsReconnect: 2 },
      waiting: [
        { kind: "activity_file", reason: null, count: 2 },
        { kind: "declare", reason: "sweatstack_409", count: 1 },
      ],
      failures: [{ kind: "activity_file", reason: "sweatstack_403", count: 3, latest: NOW }],
      lastFile: NOW - 120,
      lastWellness: NOW - 600,
    };
    expect(status(factsWith({ activity }))).toEqual({
      version: "0.7.0",
      connected: 214,
      needsReconnect: 2,
      waitingForUser: 1,
      lastFile: NOW - 120,
      lastWellness: undefined,
      jobsWaiting: 3,
      failures: 3,
    });
    expect(status(factsWith({ activity, offers: ["activities", "wellness"] })).lastWellness).toBe(NOW - 600);
  });
});

describe("the links", () => {
  it("go straight to the app's tab in SweatStack", () => {
    expect(sweatstackTab(factsWith(), "data-sources")).toBe("https://app.sweatstack.no/applications/app-1/data-sources");
    expect(sweatstackTab(factsWith({ sweatstack: null }), "oauth")).toBeNull();
  });

  it.each([
    ["https://sweatstack-bridge.molab.workers.dev", "https://dash.cloudflare.com/?to=/:account/workers/services/view/sweatstack-bridge/production/settings"],
    ["https://garmin.molab.run", "https://dash.cloudflare.com/?to=/:account/workers-and-pages"],
  ])("go to the Worker's settings in Cloudflare from %s", (origin, link) => {
    expect(cloudflareSettings(origin)).toBe(link);
  });
});

describe("times", () => {
  it.each([
    [0, "just now"],
    [59, "just now"],
    [60, "1 minute ago"],
    [18 * 60, "18 minutes ago"],
    [3600, "1 hour ago"],
    [20 * 3600, "20 hours ago"],
    [24 * 3600, "yesterday"],
    [2 * 24 * 3600, "2 days ago"],
    [-30, "just now"],
  ])("say %i seconds ago as %j", (seconds, text) => {
    expect(ago(NOW - seconds, NOW)).toBe(text);
  });

  it("give the exact time in UTC", () => {
    expect(utc(NOW)).toBe("2027-01-15 08:00 UTC");
  });
});
