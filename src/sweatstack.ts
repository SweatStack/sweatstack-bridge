import type { Config } from "./config";
import type { Database } from "./db";
import type { Deps } from "./deps";
import { outbound } from "./http";
import type { CapabilityMap, DownloadedFile } from "./providers/types";

/** The athlete's browser may be waiting on this call, so it can't take long. */
const REQUEST_TIMEOUT_MS = 2_000;
const UPLOAD_TIMEOUT_MS = 30_000;

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

async function call(services: SweatStackServices, path: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  try {
    return await outbound(services.deps, timeoutMs)(`${services.config.sweatstackUrl}${path}`, init);
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

/** Says a connection is over. Answers the same whether SweatStack knew of it or not, so repeating is safe. */
export async function deleteConnection(services: SweatStackServices, provider: string, subject: string): Promise<void> {
  const response = await callAsApp(services, `/api/v1/applications/${services.config.appId}/connections/${provider}/${subject}`, { method: "DELETE" });
  if (!response.ok) throw new SweatStackError(response.status);
}

/** A token as this user, cached for its short life because each mint leaves a row at SweatStack. */
async function userToken(services: SweatStackServices, userId: string): Promise<string> {
  const { config, db, deps } = services;
  const cached = await db.sweatstackToken(userId, deps.now() + TOKEN_EXPIRY_MARGIN_SECONDS);
  if (cached !== null) return cached;

  const response = await callAsApp(services, `/api/v1/applications/${config.appId}/users/${userId}/token`, { method: "POST" });
  if (!response.ok) throw new SweatStackError(response.status);
  const { access_token: accessToken, expires_in: expiresIn } = (await response.json()) as { access_token: string; expires_in: number };
  await db.saveSweatstackToken(userId, accessToken, deps.now() + expiresIn);
  return accessToken;
}

/**
 * Relays one file, as the athlete. SweatStack dedupes on `externalId`, so every retry is safe.
 *
 * @returns whether SweatStack took the file, as opposed to refusing that file in particular.
 */
export async function uploadActivityFile(
  services: SweatStackServices,
  upload: { userId: string; provider: string; externalId: string; file: DownloadedFile },
): Promise<{ accepted: boolean }> {
  const attempt = async () => {
    const form = new FormData();
    form.append("files", new File([upload.file.bytes], upload.file.filename));
    form.append("external_id", upload.externalId);
    form.append("provider", upload.provider);
    return call(
      services,
      "/api/v1/activities/upload",
      { method: "POST", headers: { Authorization: `Bearer ${await userToken(services, upload.userId)}` }, body: form },
      UPLOAD_TIMEOUT_MS,
    );
  };

  // A cached token can be out of date both ways: gone bad (401), or minted before the user's grant grew
  // (403). A new one settles which, and a second refusal is the real answer.
  let response = await attempt();
  if (response.status === 401 || response.status === 403) {
    await services.db.deleteSweatstackToken(upload.userId);
    response = await attempt();
  }
  if (!response.ok) throw new SweatStackError(response.status);
  const { sources } = (await response.json()) as { sources?: { status?: string }[] };
  return { accepted: sources?.[0]?.status !== "failed" };
}
