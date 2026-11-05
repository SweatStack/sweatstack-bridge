const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/** A random, URL-safe value: 256 bits unless the caller needs less. */
export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** How a secret is stored. A plain hash is right here, because these secrets are long and random. */
export async function hashSecret(secret: string): Promise<string> {
  return hex(await sha256(secret));
}

/** The PKCE challenge of a verifier (RFC 7636, S256). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(verifier));
}

/** Compares two strings in constant time. Hashing first also hides their lengths. */
export async function secureEqual(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([sha256(a), sha256(b)]);
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= (leftBytes[index] as number) ^ (rightBytes[index] as number);
  }
  return difference === 0;
}

/**
 * The subject of a platform account: stable for as long as the key is, and revealing nothing of the
 * platform's id. The two values are separated by a byte neither can contain, so no pair can collide.
 */
export async function deriveSubject(subjectKey: string, provider: string, platformUserId: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(subjectKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${provider}\0${platformUserId}`)));
}
