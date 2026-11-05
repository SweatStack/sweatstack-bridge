import { beforeEach, describe, expect, it } from "vitest";
import { ISSUER, PROVIDER, resetDatabase, world } from "../support/world";

/** Contract: "Discovery", and the keys at `jwks_uri`. */
describe("discovery", () => {
  beforeEach(() => resetDatabase({ withSigningKey: true }));

  it("names this issuer, and endpoints that SweatStack accepts", async () => {
    const response = await world().request(`/oidc/${PROVIDER}/.well-known/openid-configuration`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as Record<string, unknown>;
    expect(document.issuer).toBe(ISSUER);
    for (const member of ["authorization_endpoint", "token_endpoint", "jwks_uri", "registration_endpoint"]) {
      expect(document[member]).toMatch(/^https:\/\/bridge\.test\/oidc\/garmin_connect\//);
    }
  });

  it("states what OpenID Connect Discovery requires, and only what the bridge does", async () => {
    const document = await (await world().request(`/oidc/${PROVIDER}/.well-known/openid-configuration`)).json();
    expect(document).toMatchObject({
      scopes_supported: ["openid"],
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("takes its issuer from the address it was reached at", async () => {
    const { request } = world();
    const response = await request(`/oidc/${PROVIDER}/.well-known/openid-configuration`);
    expect(((await response.json()) as { issuer: string }).issuer.startsWith("https://bridge.test/")).toBe(true);
  });
});

describe("keys", () => {
  it("publishes the public half of the key and nothing of the private one", async () => {
    await resetDatabase({ withSigningKey: true });
    const response = await world().request(`/oidc/${PROVIDER}/jwks`);
    expect(response.status).toBe(200);
    const { keys } = (await response.json()) as { keys: Record<string, unknown>[] };
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", kid: expect.any(String), n: expect.any(String), e: expect.any(String) });
    for (const member of ["d", "p", "q", "dp", "dq", "qi"]) expect(keys[0]).not.toHaveProperty(member);
  });

  it("answers 503 until the deploy script has made a key", async () => {
    await resetDatabase({ withSigningKey: false });
    expect((await world().request(`/oidc/${PROVIDER}/jwks`)).status).toBe(503);
  });
});
