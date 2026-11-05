import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { NO_STORE, sweatstackRedirectUri, type PlatformContext } from "../context";
import { hashSecret, randomToken } from "../crypto";
import { outbound } from "../http";
import { log } from "../log";

const SOFTWARE_STATEMENT_TYP = "software-statement+jwt";

/** SweatStack waits five seconds for the whole registration, so reading its keys has to take less. */
const KEYS_TIMEOUT_MS = 3_000;

/**
 * RFC 7591, with a software statement required: anyone who could register a client could send people
 * through the platform's consent screen under the owner's name. A new registration replaces the old
 * client, which is what makes saving the card in SweatStack again safe.
 */
export async function register(c: PlatformContext): Promise<Response> {
  const { config, db, deps, issuer, provider } = c.var;

  const body = await c.req.json<{ software_statement?: unknown }>().catch(() => null);
  if (typeof body?.software_statement !== "string") {
    return refuse(c, "invalid_software_statement", "A software statement is required.");
  }

  const redirectUri = sweatstackRedirectUri(config, provider);
  const keys = createRemoteJWKSet(new URL(`${config.sweatstackUrl}/.well-known/jwks.json`), {
    [customFetch]: outbound(deps, KEYS_TIMEOUT_MS),
    timeoutDuration: KEYS_TIMEOUT_MS,
  });

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(body.software_statement, keys, {
      algorithms: ["RS256"],
      issuer: config.sweatstackUrl,
      audience: issuer,
      typ: SOFTWARE_STATEMENT_TYP,
      requiredClaims: ["exp"],
      currentDate: new Date(deps.now() * 1000),
    }));
  } catch (error) {
    log("registration_refused", { reason: error instanceof Error ? error.name : "unknown" });
    return refuse(c, "invalid_software_statement", "The software statement did not verify.");
  }

  if (payload.software_id !== config.appId) {
    log("registration_refused", { reason: "software_id" });
    return refuse(c, "unapproved_software_statement", "The software statement is for another app.");
  }
  const { redirect_uris: redirectUris } = payload;
  if (!Array.isArray(redirectUris) || redirectUris.length !== 1 || redirectUris[0] !== redirectUri) {
    log("registration_refused", { reason: "redirect_uri" });
    return refuse(c, "invalid_redirect_uri", "The software statement names another redirect URI.");
  }

  const clientId = randomToken(16);
  const clientSecret = randomToken();
  const now = deps.now();
  await db.saveClient({
    provider: provider.name,
    client_id: clientId,
    secret_hash: await hashSecret(clientSecret),
    redirect_uri: redirectUri,
    registered_at: now,
  });
  log("client_registered", { provider: provider.name });

  return c.json(
    {
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: now,
      client_secret_expires_at: 0,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "client_secret_basic",
      grant_types: ["authorization_code"],
      response_types: ["code"],
    },
    201,
    NO_STORE,
  );
}

function refuse(c: PlatformContext, error: string, description: string): Response {
  return c.json({ error, error_description: description }, 400, NO_STORE);
}
