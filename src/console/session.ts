import { secureEqual } from "../crypto";

/**
 * Signing in to the console, and the session it gives (plan 006, C1 and C2).
 *
 * The owner signs in with the bridge's SweatStack client secret: they already hold it, and whoever holds it
 * can already do everything to the app, so the console adds no authority. The session is a cookie that only
 * a holder of that secret can make, under a key derived from it. There's no session table and no key to
 * store, and a rotated secret ends every session.
 */

export const SESSION_COOKIE = "console";
export const SESSION_SECONDS = 12 * 60 * 60;

/** Separates this key from any other use of the secret. A new version ends every session. */
const KEY_LABEL = "sweatstack-bridge console session v1";

const encoder = new TextEncoder();

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", imported, encoder.encode(message));
}

async function mac(clientSecret: string, expiry: number): Promise<string> {
  const sessionKey = await hmac(encoder.encode(clientSecret), KEY_LABEL);
  return base64url(await hmac(sessionKey, String(expiry)));
}

/** Whether `attempt` is the client secret. An empty attempt never is. */
export async function isClientSecret(attempt: string, clientSecret: string): Promise<boolean> {
  return attempt !== "" && (await secureEqual(attempt, clientSecret));
}

/** A new session's cookie value: its expiry, and a MAC over it. */
export async function newSession(clientSecret: string, now: number): Promise<string> {
  const expiry = now + SESSION_SECONDS;
  return `${expiry}.${await mac(clientSecret, expiry)}`;
}

/** Whether a cookie value is a session that this secret made, and that hasn't expired. */
export async function isSession(value: string | undefined, clientSecret: string, now: number): Promise<boolean> {
  const match = /^(\d{1,12})\.([\w-]{43})$/.exec(value ?? "");
  if (match === null) return false;
  const expiry = Number(match[1]);
  if (expiry <= now) return false;
  return secureEqual(match[2] as string, await mac(clientSecret, expiry));
}
