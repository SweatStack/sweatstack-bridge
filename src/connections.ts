import type { Config } from "./config";
import type { ConnectionRow, Database } from "./db";
import type { Deps } from "./deps";
import { PlatformError, type Provider } from "./providers/types";
import { declareConnection as sendDeclaration } from "./sweatstack";

export interface ConnectionServices {
  config: Config;
  db: Database;
  deps: Deps;
  provider: Provider;
}

/** Someone else is refreshing this connection right now: try again shortly. */
export class RefreshInProgress extends Error {
  override readonly name = "RefreshInProgress";
}

/** The platform no longer accepts this connection's grant. Only the person can fix that. */
export class NeedsReconnect extends Error {
  override readonly name = "NeedsReconnect";
}

/** An access token this close to its end isn't worth starting a request with. */
const ACCESS_TOKEN_MARGIN_SECONDS = 10 * 60;

/** Longer than any refresh takes, so a claim only runs out when a Worker stopped mid-refresh. */
const REFRESH_CLAIM_SECONDS = 60;

/**
 * Tells SweatStack what a connection provides, as it stands right now, and keeps the user it answers
 * with. The one function behind every such call, so duplicates and retries are harmless.
 *
 * @returns the user, or null while SweatStack doesn't know yet whose connection this is.
 */
export async function declare(services: ConnectionServices, connection: ConnectionRow): Promise<string | null> {
  const { db, deps, provider } = services;
  const capabilities = provider.capabilityMap({
    permissions: connection.permissions === null ? null : (JSON.parse(connection.permissions) as string[]),
    needsReconnect: connection.needs_reconnect !== 0,
    backfillDone: connection.backfill_done_at !== null,
  });

  const userId = await sendDeclaration(services, {
    provider: provider.name,
    subject: connection.sub,
    capabilities,
    // Only for a call during an authorization request, and only while the user is unknown.
    state: connection.user_id === null ? connection.rp_state : null,
  });

  if (userId !== null && userId !== connection.user_id) await db.setConnectionUser(connection.sub, userId, deps.now());
  return userId ?? connection.user_id;
}

/**
 * The access token every call to the platform uses, refreshed when it needs to be. `force` is for a token
 * the platform has just refused, whatever its expiry says.
 */
export async function accessToken(services: ConnectionServices, connection: ConnectionRow, { force = false } = {}): Promise<string> {
  const { db, deps, provider } = services;
  const now = deps.now();
  if (!force && connection.access_expires_at > now + ACCESS_TOKEN_MARGIN_SECONDS) return connection.access_token;

  const claim = now + REFRESH_CLAIM_SECONDS;
  const claimed = await db.claimRefresh(connection.sub, now, claim);
  if (claimed === null) throw new RefreshInProgress();

  // Someone may have refreshed between this job reading the row and claiming it.
  if (!force && claimed.access_expires_at > now + ACCESS_TOKEN_MARGIN_SECONDS) {
    await db.releaseRefreshClaim(connection.sub, claim, { needsReconnect: false });
    return claimed.access_token;
  }

  try {
    const tokens = await provider.refresh(claimed.refresh_token);
    await db.saveRefreshedTokens(connection.sub, claim, tokens);
    return tokens.accessToken;
  } catch (error) {
    const grantGone = error instanceof PlatformError && error.code === "invalid_grant";
    await db.releaseRefreshClaim(connection.sub, claim, { needsReconnect: grantGone });
    if (!grantGone) throw error;
    await db.enqueue({ kind: "declare", provider: provider.name, sub: connection.sub, nextAttemptAt: now, receivedAt: now });
    throw new NeedsReconnect();
  }
}
