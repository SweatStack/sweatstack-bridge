import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app";
import { ALL_PERMISSIONS, resetDatabase, world, type Client } from "../support/world";

const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };

const connection = (sub: string) => env.DB.prepare("SELECT * FROM connections WHERE sub = ?").bind(sub).first<Record<string, unknown>>();
const jobs = () => env.DB.prepare("SELECT kind, sub, next_attempt_at FROM inbox").all<{ kind: string; sub: string; next_attempt_at: number }>();

describe("what the bridge stores", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
  });

  it("keeps the platform's id nowhere, under the subject that replaces it", async () => {
    const { sub } = await w.signIn(client, kari);
    const dump = await env.DB.batch(["clients", "flows", "connections", "tokens", "inbox", "meta"].map((table) => env.DB.prepare(`SELECT * FROM ${table}`)));
    expect(JSON.stringify(dump.map((result) => result.results))).not.toContain(kari.userId);
    expect(await connection(sub)).toMatchObject({ sub, provider: "garmin_connect" });
  });

  it("stores no client secret, code or state in the clear", async () => {
    const flow = await w.consent(client, kari);
    const { results: clients } = await env.DB.prepare("SELECT * FROM clients").all();
    expect(JSON.stringify(clients)).not.toContain(client.clientSecret);
    const { results: flows } = await env.DB.prepare("SELECT code_hash FROM flows").all();
    expect(JSON.stringify(flows)).not.toContain(flow.code);
  });

  it("deletes the flow when its code is used", async () => {
    await w.signIn(client, kari);
    const { results } = await env.DB.prepare("SELECT * FROM flows").all();
    expect(results).toEqual([]);
  });

  it("clears the state once it knows the user", async () => {
    const { sub } = await w.signIn(client, kari);
    expect(await connection(sub)).toMatchObject({ user_id: expect.any(String), rp_state: null });
  });

  it("keeps the state while it waits for the user", async () => {
    const user = w.sweatstack.createUser({});
    const { sub, state } = await w.signIn(client, kari, { startedBy: user.id });
    expect(await connection(sub)).toMatchObject({ user_id: null, rp_state: state });
  });

  it("stores unknown permissions as unknown, not as none", async () => {
    w.garmin.failures.permissions.push(403);
    const { sub } = await w.signIn(client, kari);
    expect((await connection(sub))?.permissions).toBeNull();
  });

  it("stores what was granted", async () => {
    const { sub } = await w.signIn(client, kari);
    expect(JSON.parse((await connection(sub))?.permissions as string)).toEqual(ALL_PERMISSIONS);
  });

  it("puts a new consent's tokens on the row, and frees it from a refresh in flight", async () => {
    const { sub } = await w.signIn(client, kari);
    const before = await connection(sub);
    await env.DB.prepare("UPDATE connections SET refresh_claimed_until = 9999999999, needs_reconnect = 1 WHERE sub = ?").bind(sub).run();
    await w.signIn(client, kari);
    const after = await connection(sub);
    expect(after?.access_token).not.toBe(before?.access_token);
    expect(after).toMatchObject({ refresh_claimed_until: null, needs_reconnect: 0, user_id: before?.user_id });
  });

  it("works out when the tokens expire", async () => {
    const { sub } = await w.signIn(client, kari);
    expect(await connection(sub)).toMatchObject({
      access_expires_at: w.clock.now + 24 * 60 * 60,
      refresh_expires_at: w.clock.now + 90 * 24 * 60 * 60,
      consented_at: w.clock.now,
    });
  });
});

describe("what's left for the job", () => {
  beforeEach(() => resetDatabase({ withSigningKey: true }));

  it("adds nothing when the user is known at once", async () => {
    const w = world();
    await w.signIn(await w.register(), kari);
    expect((await jobs()).results).toEqual([]);
  });

  it("adds a declare job while a connection waits for its user", async () => {
    const w = world();
    const client = await w.register();
    const user = w.sweatstack.createUser({});
    const { sub } = await w.signIn(client, kari, { startedBy: user.id });
    expect((await jobs()).results).toEqual([{ kind: "declare", sub, next_attempt_at: w.clock.now + 60 }]);
  });

  it("adds a declare job when the connection call fails", async () => {
    const w = world({ intercept: (request) => (request.method === "PUT" ? new Response(null, { status: 503 }) : undefined) });
    const { sub } = await w.signIn(await w.register(), kari);
    expect((await jobs()).results).toEqual([{ kind: "declare", sub, next_attempt_at: w.clock.now + 60 }]);
  });
});

describe("when a request fails", () => {
  const failing = (message: string) => {
    const bridgeEnv = {
      SWEATSTACK_URL: "https://sweatstack.test",
      SWEATSTACK_APP_ID: "app",
      SWEATSTACK_CLIENT_SECRET: "secret",
      GARMIN_CLIENT_ID: "id",
      GARMIN_CLIENT_SECRET: "secret",
      DB: {
        prepare: () => {
          throw new Error(message);
        },
      } as unknown as D1Database,
    };
    const app = createApp({ env: bridgeEnv, fetch: () => Promise.reject(new Error("no network")), now: () => 0, sleep: async () => {}, waitUntil: () => {} });
    return app.request("https://bridge.test/oidc/garmin_connect/authorize", undefined, bridgeEnv);
  };

  const logged = async (message: string) => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect((await failing(message)).status).toBe(500);
      return String(spy.mock.calls[0]?.[0]);
    } finally {
      spy.mockRestore();
    }
  };

  it("logs the route and a database's reason", async () => {
    const line = await logged("D1_ERROR: table flows has no column named x: SQLITE_ERROR");
    expect(JSON.parse(line)).toEqual({
      event: "request_failed",
      error: "Error",
      route: "/oidc/:provider/authorize",
      detail: "D1_ERROR: table flows has no column named x: SQLITE_ERROR",
    });
  });

  it("doesn't log any other message, which could carry a URL or a token", async () => {
    expect(await logged("Bearer a-secret-token")).not.toContain("a-secret-token");
  });
});

describe("the capability map", () => {
  it("is the same as the shared fixtures say", async () => {
    const { default: fixtures } = await import("../fixtures/garmin/capability-maps.json");
    const { garmin } = await import("../../src/providers/garmin");
    const provider = garmin({ env: { DB: env.DB }, fetch: () => Promise.reject(new Error("no network")), now: () => 0 });
    for (const { state, capabilities } of fixtures) expect(provider.capabilityMap(state)).toEqual(capabilities);
  });
});
