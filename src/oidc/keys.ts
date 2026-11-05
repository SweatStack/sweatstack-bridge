import { importJWK, type CryptoKey, type JWK } from "jose";
import type { PlatformContext } from "../context";
import type { Database } from "../db";

interface SigningKey {
  kid: string;
  key: CryptoKey | Uint8Array;
}

const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi"] as const;

/** The deploy script makes the key (scripts/lib/signing-key.mjs). Null until it has. */
async function storedJwk(db: Database): Promise<(JWK & { kid: string }) | null> {
  const stored = await db.meta("signing_key");
  return stored === null ? null : (JSON.parse(stored) as JWK & { kid: string });
}

export async function signingKey(db: Database): Promise<SigningKey | null> {
  const jwk = await storedJwk(db);
  return jwk === null ? null : { kid: jwk.kid, key: await importJWK(jwk, "RS256") };
}

export async function jwks(c: PlatformContext): Promise<Response> {
  const jwk = await storedJwk(c.var.db);
  if (jwk === null) return c.json({ error: "temporarily_unavailable" }, 503);
  const publicJwk: JWK = { ...jwk };
  for (const member of PRIVATE_MEMBERS) delete publicJwk[member];
  return c.json({ keys: [publicJwk] });
}
