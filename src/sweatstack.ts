import type { Config } from "./config";
import type { Database } from "./db";
import type { Deps } from "./deps";
import { outbound } from "./http";
import type { CapabilityMap } from "./providers/types";

/** The athlete's browser may be waiting on this call, so it can't take long. */
const REQUEST_TIMEOUT_MS = 2_000;

/** A token this close to its end isn't worth starting a request with. */
const TOKEN_EXPIRY_MARGIN_SECONDS = 30;

const CLIENT_TOKEN_HOLDER = "client";

export interface SweatStackServices {
  config: Config;
  db: Database;
  deps: Pick<Deps, "fetch" | "now">;
}

/** A call to SweatStack failed. The status is absent when it never answered. */
export class SweatStackError extends Error {
  override readonly name = "SweatStackError";

  constructor(readonly status?: number) {
    super(status === undefined ? "SweatStack didn't answer" : `SweatStack answered ${status}`);
  }
}

async function call(services: SweatStackServices, path: string, init: RequestInit): Promise<Response> {
  try {
    return await outbound(services.deps, REQUEST_TIMEOUT_MS)(`${services.config.sweatstackUrl}${path}`, init);
  } catch {
    throw new SweatStackError();
  }
}

/** The app's own token (the client credentials grant), cached because each mint leaves a row at SweatStack. */
async function clientToken(services: SweatStackServices): Promise<string> {
  const { config, db, deps } = services;
  const cached = await db.sweatstackToken(CLIENT_TOKEN_HOLDER, deps.now() + TOKEN_EXPIRY_MARGIN_SECONDS);
  if (cached !== null) return cached;

  const response = await call(services, "/api/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${config.appId}:${config.clientSecret}`)}` },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  });
  if (!response.ok) throw new SweatStackError(response.status);
  const { access_token: accessToken, expires_in: expiresIn } = (await response.json()) as { access_token: string; expires_in: number };
  await db.saveSweatstackToken(CLIENT_TOKEN_HOLDER, accessToken, deps.now() + expiresIn);
  return accessToken;
}

/** A call as the app. A `401` means the cached token has gone bad, so it gets one new token and one more try. */
async function callAsApp(services: SweatStackServices, path: string, init: RequestInit): Promise<Response> {
  const attempt = async () =>
    call(services, path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await clientToken(services)}` } });
  const response = await attempt();
  if (response.status !== 401) return response;
  await services.db.deleteSweatstackToken(CLIENT_TOKEN_HOLDER);
  return attempt();
}

/**
 * The connection call: states what a connection provides, and learns whose it is.
 *
 * @returns the user, or null while SweatStack doesn't know yet.
 */
export async function declareConnection(
  services: SweatStackServices,
  declaration: { provider: string; subject: string; capabilities: CapabilityMap; state: string | null },
): Promise<string | null> {
  const { appId } = services.config;
  const body = {
    capabilities: declaration.capabilities,
    ...(declaration.state === null ? {} : { state: declaration.state }),
  };
  const response = await callAsApp(services, `/api/v1/applications/${appId}/connections/${declaration.provider}/${declaration.subject}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new SweatStackError(response.status);
  const { user_id: userId } = (await response.json()) as { user_id: string | null };
  return userId;
}
