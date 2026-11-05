import { beforeEach, describe, expect, it } from "vitest";
import { FakeSweatStack } from "../fakes/sweatstack";
import { ISSUER, resetDatabase, world } from "../support/world";

/** Contract: "Registration". Refuses anything but a valid statement. */
describe("registration", () => {
  beforeEach(() => resetDatabase({ withSigningKey: true }));

  it("gives a client id and secret for a valid statement", async () => {
    const { postRegistration, sweatstack } = world();
    const response = await postRegistration({
      software_statement: await sweatstack.softwareStatement({ issuer: ISSUER }),
      redirect_uris: [sweatstack.redirectUri()],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      client_id: expect.any(String),
      client_secret: expect.any(String),
      client_secret_expires_at: 0,
      redirect_uris: [sweatstack.redirectUri()],
    });
  });

  it("refuses open registration", async () => {
    const { postRegistration, sweatstack } = world();
    for (const body of [{}, { redirect_uris: [sweatstack.redirectUri()] }, { software_statement: 42 }, { software_statement: "not-a-token" }]) {
      const response = await postRegistration(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_software_statement" });
    }
  });

  it("refuses a body that isn't JSON", async () => {
    const { request } = world();
    const response = await request("/oidc/garmin_connect/register", { method: "POST", body: "nonsense" });
    expect(response.status).toBe(400);
  });

  it.each([
    ["another app", { softwareId: "another-app" }, "unapproved_software_statement"],
    ["another redirect URI", { redirectUri: "https://attacker.test/callback" }, "invalid_redirect_uri"],
    ["another audience", { issuer: "https://another-bridge.test/oidc/garmin_connect" }, "invalid_software_statement"],
    ["another issuer", { signedBy: "https://another-sweatstack.test" }, "invalid_software_statement"],
    ["another kind of token", { typ: "secevent+jwt" }, "invalid_software_statement"],
    ["an expired statement", { lifetimeSeconds: -1 }, "invalid_software_statement"],
  ])("refuses a statement for %s", async (_name, overrides, error) => {
    const { postRegistration, sweatstack } = world();
    const statement = await sweatstack.softwareStatement({ issuer: ISSUER, ...overrides });
    const response = await postRegistration({ software_statement: statement });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error });
  });

  it("refuses a statement signed with a key that isn't SweatStack's", async () => {
    const { postRegistration } = world();
    const stranger = new FakeSweatStack();
    const statement = await stranger.softwareStatement({ issuer: ISSUER });
    expect((await postRegistration({ software_statement: statement })).status).toBe(400);
  });

  it("refuses when it can't reach SweatStack's keys", async () => {
    const { postRegistration, sweatstack } = world({
      intercept: () => {
        throw new Error("SweatStack is down");
      },
    });
    const response = await postRegistration({ software_statement: await sweatstack.softwareStatement({ issuer: ISSUER }) });
    expect(response.status).toBe(400);
  });

  it("replaces the client when SweatStack registers again, and the old one stops working", async () => {
    const { authorize, register } = world();
    const first = await register();
    const second = await register();
    expect(second.clientId).not.toBe(first.clientId);
    expect((await authorize(first)).status).toBe(400);
    expect((await authorize(second)).status).toBe(302);
  });
});
