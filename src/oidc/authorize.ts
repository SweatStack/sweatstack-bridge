import { errorRedirect, type PlatformContext } from "../context";
import { pkceChallenge, randomToken } from "../crypto";

const FLOW_LIFETIME_SECONDS = 60 * 60;

/** A base64url SHA-256 digest: what S256 produces. */
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Starts a sign-in or a connect. The bridge can't tell which, and doesn't need to: SweatStack decides
 * who the result belongs to when the browser returns.
 */
export async function authorize(c: PlatformContext): Promise<Response> {
  const { callbackUrl, db, deps, provider } = c.var;
  const query = c.req.query();

  // Until the client and its redirect URI check out, there's nowhere safe to send an error.
  const client = await db.client(provider.name);
  if (client === null || query.client_id !== client.client_id || query.redirect_uri !== client.redirect_uri) {
    return c.text("This sign-in link isn't valid. Go back to the app and start again.\n", 400);
  }

  const refuse = (error: string) => c.redirect(errorRedirect(client.redirect_uri, error, query.state), 302);

  if (query.response_type !== "code") return refuse("unsupported_response_type");
  if (!query.scope?.split(" ").includes("openid")) return refuse("invalid_scope");
  if (!query.state) return refuse("invalid_request");
  if (query.code_challenge_method !== "S256" || !S256_CHALLENGE.test(query.code_challenge ?? "")) {
    return refuse("invalid_request");
  }
  // The bridge holds no session, so it can never answer without showing the platform's consent.
  if (query.prompt === "none") return refuse("login_required");

  const id = randomToken();
  const verifier = randomToken();
  await db.createFlow({
    id,
    provider: provider.name,
    platform_verifier: verifier,
    rp_client_id: client.client_id,
    rp_state: query.state,
    rp_nonce: query.nonce ?? null,
    rp_redirect_uri: client.redirect_uri,
    rp_code_challenge: query.code_challenge as string,
    expires_at: deps.now() + FLOW_LIFETIME_SECONDS,
  });

  return c.redirect(
    provider.authorizeUrl({ redirectUri: callbackUrl, state: id, codeChallenge: await pkceChallenge(verifier) }),
    302,
  );
}
