import type { PlatformContext } from "../context";
import { pkceChallenge } from "../crypto";

/**
 * Sends the browser on to the platform's consent for a flow that's already in the database. The console's
 * verification walk writes such a flow, for the platform's partner verification. Only the
 * bridge holds the platform's client id, so the link goes through here. Nobody can start a flow this way:
 * it only leads on for one that exists, isn't used and hasn't expired, which says no more than the
 * platform's link itself would.
 */
export async function start(c: PlatformContext): Promise<Response> {
  const { callbackUrl, db, deps, provider } = c.var;
  const flow = await db.openFlow(c.req.param("flow") ?? "", provider.name, deps.now());
  if (flow === null) return c.text("This link has expired or was already used. Get a new one in the verification walk, in your bridge's console.\n", 400);
  return c.redirect(provider.authorizeUrl({ redirectUri: callbackUrl, state: flow.id, codeChallenge: await pkceChallenge(flow.platform_verifier) }), 302);
}
