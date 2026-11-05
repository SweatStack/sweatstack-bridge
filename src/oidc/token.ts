import { SignJWT } from "jose";
import { NO_STORE, type PlatformContext } from "../context";
import { hashSecret, pkceChallenge, randomToken, secureEqual } from "../crypto";
import { waitForUser } from "../flows/finish";
import { signingKey } from "./keys";

const ID_TOKEN_LIFETIME_SECONDS = 5 * 60;

export async function token(c: PlatformContext): Promise<Response> {
  const { config, db, deps, issuer, provider } = c.var;

  // Before anything else, so that a stranger can't use up someone's code.
  const clientId = await authenticatedClient(c);
  if (clientId === null) {
    return c.json({ error: "invalid_client" }, 401, { ...NO_STORE, "WWW-Authenticate": 'Basic realm="token"' });
  }

  const form = await c.req.parseBody();
  if (form.grant_type !== "authorization_code") return refuse(c, "unsupported_grant_type");
  const { code, code_verifier: verifier, redirect_uri: redirectUri } = form;
  if (typeof code !== "string" || typeof verifier !== "string" || typeof redirectUri !== "string") {
    return refuse(c, "invalid_request");
  }

  const key = await signingKey(db);
  if (key === null) return c.json({ error: "temporarily_unavailable" }, 503, NO_STORE);

  // A wrong verifier also uses up the code: a failed attempt may be someone holding a stolen one.
  const flow = await db.redeemCode(await hashSecret(code), provider.name, deps.now());
  if (
    flow === null ||
    flow.sub === null ||
    flow.rp_client_id !== clientId ||
    flow.rp_redirect_uri !== redirectUri ||
    !(await secureEqual(await pkceChallenge(verifier), flow.rp_code_challenge))
  ) {
    return refuse(c, "invalid_grant");
  }

  const now = deps.now();
  const claims = flow.rp_nonce === null ? {} : { nonce: flow.rp_nonce };
  const idToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: key.kid })
    .setIssuer(issuer)
    .setSubject(flow.sub)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + ID_TOKEN_LIFETIME_SECONDS)
    .sign(key.key);

  // SweatStack exchanging the code is the sign that the link is about to happen, but it only links once
  // it has this answer. So this answer goes first, and asking for the user carries on behind it.
  deps.waitUntil(waitForUser({ config, db, deps, provider }, flow.sub));

  return c.json(
    {
      id_token: idToken,
      // OAuth 2.0 requires one, and nothing here accepts it: the bridge has no UserInfo endpoint.
      access_token: randomToken(),
      token_type: "Bearer",
      expires_in: ID_TOKEN_LIFETIME_SECONDS,
      scope: "openid",
    },
    200,
    NO_STORE,
  );
}

/** The client id, if the request carries this platform's client's credentials (`client_secret_basic`). */
async function authenticatedClient(c: PlatformContext): Promise<string | null> {
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return null;

  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  const clientId = decodeForm(decoded.slice(0, separator));
  const clientSecret = decodeForm(decoded.slice(separator + 1));

  const client = await c.var.db.client(c.var.provider.name);
  if (client === null) return null;
  const matches = await Promise.all([
    secureEqual(clientId, client.client_id),
    secureEqual(await hashSecret(clientSecret), client.secret_hash),
  ]);
  return matches.every(Boolean) ? client.client_id : null;
}

/** RFC 6749 2.3.1 has Basic credentials form-encoded. A value that isn't stays as it is, and won't match. */
function decodeForm(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

function refuse(c: PlatformContext, error: string): Response {
  return c.json({ error }, 400, NO_STORE);
}
