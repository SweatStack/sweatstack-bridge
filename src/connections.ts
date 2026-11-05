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

/** Stored permissions, which can be unknown. */
export function permissionsOf(connection: ConnectionRow): string[] | null {
  return connection.permissions === null ? null : (JSON.parse(connection.permissions) as string[]);
}

/**
 * Tells SweatStack what a connection provides, as it stands right now, and keeps the user it answers
 * with. The one function behind every such call, so duplicates and retries are harmless.
 *
 * @returns the user, or null while SweatStack doesn't know yet whose connection this is.
 */
export async function declare(services: ConnectionServices, connection: ConnectionRow): Promise<string | null> {
  const { db, deps, provider } = services;
  const capabilities = provider.capabilityMap({
    permissions: permissionsOf(connection),
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
  const margin = services.deps.now() + ACCESS_TOKEN_MARGIN_SECONDS;
  if (!force && connection.access_expires_at > margin) return connection.access_token;
  return refreshUnderClaim(services, connection.sub, (row) => force || row.access_expires_at <= margin);
}

/** A call to the platform with the connection's access token. If the platform refuses that token, it's refreshed once. */
export async function withAccessToken<T>(services: ConnectionServices, connection: ConnectionRow, call: (token: string) => Promise<T>): Promise<T> {
  try {
    return await call(await accessToken(services, connection));
  } catch (error) {
    if (!(error instanceof PlatformError) || error.status !== 401) throw error;
    return call(await accessToken(services, connection, { force: true }));
  }
}

/**
 * Refreshes a quiet connection's grant before it lapses. The platform replaces the refresh token every
 * time, so this happens only for one that's still due once its claim is held.
 */
export async function keepGrantAlive(services: ConnectionServices, connection: ConnectionRow, refreshBefore: number): Promise<void> {
  await refreshUnderClaim(services, connection.sub, (row) => row.refresh_expires_at <= refreshBefore);
}

/**
 * Tells the platform to stop sending this account's data. Throws only for what trying again can fix: any
 * other refusal means the token is already gone, and so there's nothing left to deregister.
 */
export async function deregisterAtPlatform(services: ConnectionServices, connection: ConnectionRow): Promise<void> {
  try {
    await withAccessToken(services, connection, (token) => services.provider.deregister(token));
  } catch (error) {
    if (error instanceof NeedsReconnect) return;
    if (error instanceof PlatformError && error.status !== undefined && error.status < 500 && error.status !== 429) return;
    throw error;
  }
}

/**
 * The one place a refresh token is spent. It's claimed first, because using a spent one may revoke the
 * grant, and `stillNeeded` looks at the row under the claim, because someone may have refreshed just before.
 *
 * @returns the access token to use.
 */
async function refreshUnderClaim(services: ConnectionServices, sub: string, stillNeeded: (row: ConnectionRow) => boolean): Promise<string> {
  const { db, deps, provider } = services;
  const now = deps.now();
  const claim = now + REFRESH_CLAIM_SECONDS;
  const claimed = await db.claimRefresh(sub, now, claim);
  if (claimed === null) throw new RefreshInProgress();

  // The platform has refused this grant, and it's been declared. Only a new consent changes that, so
  // however many jobs retry, nothing more goes to the platform or to SweatStack.
  if (claimed.needs_reconnect !== 0) {
    await db.releaseRefreshClaim(sub, claim, { needsReconnect: true });
    throw new NeedsReconnect();
  }

  if (!stillNeeded(claimed)) {
    await db.releaseRefreshClaim(sub, claim, { needsReconnect: false });
    return claimed.access_token;
  }

  try {
    const tokens = await provider.refresh(claimed.refresh_token);
    await db.saveRefreshedTokens(sub, claim, tokens);
    return tokens.accessToken;
  } catch (error) {
    const grantGone = error instanceof PlatformError && error.code === "invalid_grant";
    await db.releaseRefreshClaim(sub, claim, { needsReconnect: grantGone });
    if (!grantGone) throw error;
    await db.enqueue({ kind: "declare", provider: provider.name, sub, nextAttemptAt: now, receivedAt: now });
    throw new NeedsReconnect();
  }
}
