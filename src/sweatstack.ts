import { createRemoteJWKSet, customFetch } from "jose";
import type { Config } from "./config";
import type { Database } from "./db";
import type { Deps } from "./deps";
import { outbound } from "./http";
import type { CapabilityMap, DailyValue, DownloadedFile } from "./providers/types";

/** The athlete's browser may be waiting on this call, so it can't take long. */
const REQUEST_TIMEOUT_MS = 2_000;
const UPLOAD_TIMEOUT_MS = 30_000;
/** Nobody waits on a daily value, so it can take its time. */
const DAILY_TIMEOUT_MS = 10_000;

/** A token this close to its end isn't worth starting a request with. */
const TOKEN_EXPIRY_MARGIN_SECONDS = 30;

const CLIENT_TOKEN_HOLDER = "client";

/** SweatStack waits five seconds for whoever it signs a request to, so reading its keys has to take less. */
const KEYS_TIMEOUT_MS = 3_000;

export interface SweatStackServices {
  config: Config;
  db: Database;
  deps: Pick<Deps, "fetch" | "now">;
}

/** The keys behind everything SweatStack signs. */
export function sweatstackKeys(config: Config, deps: Pick<Deps, "fetch">) {
  return createRemoteJWKSet(new URL(`${config.sweatstackUrl}/.well-known/jwks.json`), {
    [customFetch]: outbound(deps, KEYS_TIMEOUT_MS),
    timeoutDuration: KEYS_TIMEOUT_MS,
  });
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
  declaration: { provider: string; subject: string; capabilities: CapabilityMap; state: string | null; platformUserId?: string },
): Promise<string | null> {
  const { appId } = services.config;
  const body = {
    capabilities: declaration.capabilities,
    ...(declaration.state === null ? {} : { state: declaration.state }),
    // Goes with `state`, so that SweatStack can ask someone who already uses the app whether to move their account.
    ...(declaration.state === null || declaration.platformUserId === undefined ? {} : { platform_user_id: declaration.platformUserId }),
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

/**
 * What the bridge does as a user, each with a token that can do only that. Apart, so an app that hasn't ticked
 * what one needs loses that one alone. The holder is where the token is cached.
 */
const PURPOSES = {
  files: { scope: "activities:write", holder: (userId: string) => userId },
  wellness: { scope: "wellness:write", holder: (userId: string) => `${userId} wellness` },
} as const;

type Purpose = keyof typeof PURPOSES;

/** A token as this user, cached for its short life because each mint leaves a row at SweatStack. */
async function userToken(services: SweatStackServices, userId: string, purpose: Purpose): Promise<string> {
  const { config, db, deps } = services;
  const { scope, holder } = PURPOSES[purpose];
  const cached = await db.sweatstackToken(holder(userId), deps.now() + TOKEN_EXPIRY_MARGIN_SECONDS);
  if (cached !== null) return cached;

  const response = await callAsApp(services, `/api/v1/applications/${config.appId}/users/${userId}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope }),
  });
  if (!response.ok) throw new SweatStackError(response.status);
  const { access_token: accessToken, expires_in: expiresIn } = (await response.json()) as { access_token: string; expires_in: number };
  await db.saveSweatstackToken(holder(userId), accessToken, deps.now() + expiresIn);
  return accessToken;
}

/**
 * A call as the user. A cached token can have gone bad, and a new one settles that. A 403 can't be fixed
 * that way: the token was minted to hold the one scope the call needs.
 */
async function callAsUser(services: SweatStackServices, userId: string, purpose: Purpose, request: (token: string) => Promise<Response>): Promise<Response> {
  const response = await request(await userToken(services, userId, purpose));
  if (response.status !== 401) return response;
  await services.db.deleteSweatstackToken(PURPOSES[purpose].holder(userId));
  return request(await userToken(services, userId, purpose));
}

/**
 * Relays one file, as the athlete. SweatStack dedupes on `externalId`, so every retry is safe. It reads
 * `platform` to attribute the file, to count it for the connection, and to recognise a file an account
 * that moved to the app already holds, which it then takes over instead of storing twice.
 *
 * @returns whether SweatStack took the file, as opposed to refusing that file in particular.
 */
export async function uploadActivityFile(
  services: SweatStackServices,
  upload: { userId: string; platform: string; externalId: string; file: DownloadedFile },
): Promise<{ accepted: boolean }> {
  const response = await callAsUser(services, upload.userId, "files", (token) => {
    const form = new FormData();
    form.append("files", new File([upload.file.bytes], upload.file.filename));
    form.append("external_id", upload.externalId);
    form.append("platform", upload.platform);
    return call(services, "/api/v1/activities/upload", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form }, UPLOAD_TIMEOUT_MS);
  });
  if (!response.ok) throw new SweatStackError(response.status);
  const { sources } = (await response.json()) as { sources?: { status?: string }[] };
  return { accepted: sources?.[0]?.status !== "failed" };
}

/**
 * Writes one daily value as the athlete, naming the platform it came from. It replaces whatever the day
 * held, so sending the same value again is safe.
 *
 * @returns whether SweatStack took the value, as opposed to refusing that value in particular, as it does
 * one outside the measure's range.
 */
export async function writeDaily(services: SweatStackServices, daily: DailyValue & { userId: string; platform: string }): Promise<{ accepted: boolean }> {
  const response = await callAsUser(services, daily.userId, "wellness", (token) =>
    call(
      services,
      `/api/v1/dailies/${encodeURIComponent(daily.measure)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ date: daily.date, value: daily.value, platform: daily.platform }),
      },
      DAILY_TIMEOUT_MS,
    ),
  );
  if (response.status === 422) return { accepted: false };
  if (!response.ok) throw new SweatStackError(response.status);
  return { accepted: true };
}
