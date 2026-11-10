import type { PlatformContext } from "../context";
import { pkceChallenge } from "../crypto";

/**
 * Sends the browser on to the platform's consent for a flow that's already in the database. `npm run verify`
 * writes such a flow through the owner's Cloudflare login, for the platform's partner verification. Only the
 * bridge holds the platform's client id, so the link goes through here. Nobody can start a flow this way:
 * it only leads on for one that exists, isn't used and hasn't expired, which says no more than the
 * platform's link itself would.
 */
export async function start(c: PlatformContext): Promise<Response> {
  const { callbackUrl, db, deps, provider } = c.var;
  const flow = await db.openFlow(c.req.param("flow") ?? "", provider.name, deps.now());
  if (flow === null) return c.text("This link has expired or was already used. Run npm run verify for a new one.\n", 400);
  return c.redirect(provider.authorizeUrl({ redirectUri: callbackUrl, state: flow.id, codeChallenge: await pkceChallenge(flow.platform_verifier) }), 302);
}
