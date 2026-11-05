import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

/**
 * The private JWK the Worker signs ID tokens with, as the JSON stored in `meta`. Made here and not in
 * the Worker, because generating an RSA key takes 25 to 220 ms of CPU and the free plan allows 10 ms
 * per request. Signing takes 1 to 3 ms.
 *
 * @returns {Promise<string>}
 */
export async function generateSigningKey() {
  const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(jwk);
  return JSON.stringify({ ...jwk, kid, alg: "RS256", use: "sig" });
}
