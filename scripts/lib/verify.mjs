/**
 * A Garmin sign-in that the bridge starts itself, for Garmin's partner verification. It's an ordinary flow
 * whose user SweatStack never names, so the bridge treats the account as any connection nobody claims: its
 * pushes wait, nothing reaches SweatStack, and after a day it's deregistered and deleted.
 */

const PROVIDER = "garmin_connect";
const LIFETIME_SECONDS = 60 * 60;

/** Where the browser lands after Garmin's consent: the next steps. Checked against RUNBOOK.md's headings. */
export const RUNBOOK_SECTION = "https://github.com/SweatStack/sweatstack-bridge/blob/main/RUNBOOK.md#pass-garmins-verification";

/** A random, URL-safe value of 256 bits, as `randomToken` in src/crypto.ts makes them: 43 characters. */
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The row to write and the path that starts the sign-in. The relying party's values belong to nobody:
 * SweatStack never saw the `state`, the code challenge is random so no verifier matches it, and no client
 * has the empty client id. So the code that the consent issues can never be redeemed.
 * @param {{ now: number }} options seconds since the epoch
 */
export function verificationSignIn({ now }) {
  const id = randomToken();
  const expiresAt = now + LIFETIME_SECONDS;
  const row = {
    id,
    provider: PROVIDER,
    platform_verifier: randomToken(),
    rp_state: randomToken(),
    rp_redirect_uri: RUNBOOK_SECTION,
    rp_code_challenge: randomToken(),
    expires_at: expiresAt,
  };
  const values = Object.values(row).map((value) => (typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`));
  return {
    sql: `INSERT INTO flows (${Object.keys(row).join(", ")}) VALUES (${values.join(", ")})`,
    path: `/start/${PROVIDER}/${id}`,
    expiresAt,
  };
}
