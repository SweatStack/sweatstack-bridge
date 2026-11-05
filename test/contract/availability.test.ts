import { describe, expect, it } from "vitest";
import { testBridge } from "../support/bridge";

describe("before the owner has finished the setup", () => {
  const unconfigured = () => testBridge({ settings: {} });

  it("still serves the root, with no data on it", async () => {
    const response = await unconfigured().request("/");
    expect(response.status).toBe(200);
    expect(await response.text()).toMatch(/^A SweatStack bridge\. See https:\/\/github\.com\/\S+\n$/);
  });

  it("answers the OpenID routes with 503, and doesn't say what's missing", async () => {
    const response = await unconfigured().request("/oidc/garmin_connect/.well-known/openid-configuration");
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/SWEATSTACK|GARMIN|SECRET/);
  });
});

describe("routes", () => {
  it("answers 404 for a platform it doesn't run", async () => {
    const response = await testBridge().request("/oidc/no_such_platform/.well-known/openid-configuration");
    expect(response.status).toBe(404);
  });

  it("answers 404 for anything else", async () => {
    expect((await testBridge().request("/nothing-here")).status).toBe(404);
  });
});
