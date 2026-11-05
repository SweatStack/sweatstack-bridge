import { SignJWT, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { generateSigningKey } from "../../scripts/lib/signing-key.mjs";

describe("the signing key the deploy script makes", () => {
  it("signs an RS256 token that its public half verifies, in the Workers runtime", async () => {
    const jwk = JSON.parse(await generateSigningKey());
    expect(jwk).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig", kid: expect.any(String), d: expect.any(String) });
    expect(jwk.kid).not.toBe("");

    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .sign(await importJWK(jwk, "RS256"));

    const { d, p, q, dp, dq, qi, ...publicJwk } = jwk;
    const { protectedHeader } = await jwtVerify(token, await importJWK(publicJwk, "RS256"));
    expect(protectedHeader.kid).toBe(jwk.kid);
  });
});
