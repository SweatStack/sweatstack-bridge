import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import type { Env } from "../../src/config";
import { network } from "../support/network";
import { ORIGIN, world } from "../support/world";

describe("before the owner has finished the setup", () => {
  const bridgeEnv: Env = { DB: env.DB };
  const app = createApp({
    env: bridgeEnv,
    fetch: network({}),
    now: () => 0,
    sleep: async () => {},
    waitUntil: () => {},
  });
  const request = (path: string) => app.request(`${ORIGIN}${path}`, undefined, bridgeEnv);

  it("still serves the root, with no data on it", async () => {
    const response = await request("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/^A SweatStack bridge\. See https:\/\/github\.com\/\S+\n$/);
  });

  it.each(["/.well-known/openid-configuration", "/authorize", "/jwks"])("answers %s with 503, and doesn't say what's missing", async (path) => {
    const response = await request(`/oidc/garmin_connect${path}`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/SWEATSTACK|GARMIN|SECRET/);
  });
});

describe("routes", () => {
  it("answers 404 for a platform it doesn't run", async () => {
    expect((await world().request("/oidc/no_such_platform/.well-known/openid-configuration")).status).toBe(404);
    expect((await world().request("/oidc/constructor/.well-known/openid-configuration")).status).toBe(404);
    expect((await world().request("/callback/no_such_platform")).status).toBe(404);
  });

  it("answers 404 for anything else", async () => {
    expect((await world().request("/nothing-here")).status).toBe(404);
    expect((await world().request("/oidc/garmin_connect/nothing-here")).status).toBe(404);
  });
});
