import { errorRedirect, type PlatformContext } from "../context";
import { deriveSubject, hashSecret, randomToken } from "../crypto";
import { log } from "../log";
import { PlatformError } from "../providers/types";
import { declareAfterConsent } from "./finish";

const CODE_LIFETIME_SECONDS = 10 * 60;

/** Where both a sign-in and a connect finish: the platform's redirect, after its consent. */
export async function platformCallback(c: PlatformContext): Promise<Response> {
  const { callbackUrl, config, db, deps, provider } = c.var;
  const { code, error, state } = c.req.query();

  const flow = state ? await db.takeFlow(state, provider.name, deps.now()) : null;
  if (flow === null) {
    return c.text("This sign-in has expired or was already used. Go back to the app and start again.\n", 400);
  }

  const backToSweatStack = async (oauthError: string) => {
    await db.deleteFlow(flow.id);
    return c.redirect(errorRedirect(flow.rp_redirect_uri, oauthError, flow.rp_state), 302);
  };

  if (error !== undefined) return backToSweatStack(error === "access_denied" ? "access_denied" : "server_error");
  if (!code) return backToSweatStack("server_error");

  const issued = randomToken();
  try {
    const tokens = await provider.exchangeCode({ code, codeVerifier: flow.platform_verifier, redirectUri: callbackUrl });
    const platformUserId = await provider.identify(tokens.accessToken);
    const permissions = await provider.fetchPermissions(tokens.accessToken).catch(() => null);
    const subjectKey = await db.meta("subject_key");
    if (subjectKey === null) throw new Error("The database has no subject key");
    const sub = await deriveSubject(subjectKey, provider.name, platformUserId);
    const followUps = permissions === null ? (["permissions_change"] as const) : provider.mayBackfill(permissions) ? (["backfill"] as const) : [];
    await db.saveConsent({ sub, provider: provider.name, ...tokens, permissions, consentedAt: deps.now() }, [...followUps]);
    await declareAfterConsent({ config, db, deps, provider }, sub, { state: flow.rp_state, platformUserId });
    await db.issueCode(flow.id, await hashSecret(issued), sub, deps.now() + CODE_LIFETIME_SECONDS);
  } catch (failure) {
    log("consent_failed", {
      provider: provider.name,
      error: failure instanceof Error ? failure.name : "unknown",
      status: failure instanceof PlatformError ? (failure.status ?? null) : null,
    });
    return backToSweatStack("server_error");
  }

  const redirect = new URL(flow.rp_redirect_uri);
  redirect.searchParams.set("code", issued);
  redirect.searchParams.set("state", flow.rp_state);
  return c.redirect(redirect.toString(), 302);
}
