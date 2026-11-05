import type { Deps } from "../deps";
import { outbound } from "../http";
import { PlatformError, type CapabilityMap, type ConnectionState, type PlatformTokens, type Provider } from "./types";

const AUTHORIZE_URL = "https://connect.garmin.com/oauth2Confirm";
const TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const USER_ID_URL = "https://apis.garmin.com/partner-gateway/rest/user/id";
const PERMISSIONS_URL = "https://apis.garmin.com/partner-gateway/rest/user/permissions";

const ACTIVITY_EXPORT = "ACTIVITY_EXPORT";
const HISTORICAL_DATA_EXPORT = "HISTORICAL_DATA_EXPORT";

const REQUEST_TIMEOUT_MS = 8_000;

/** For a token response that doesn't say. Short of Garmin's 90 days, so the token gets refreshed early. */
const REFRESH_FALLBACK_LIFETIME_SECONDS = 80 * 24 * 60 * 60;

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  refresh_token_expires_in?: unknown;
}

export const GARMIN_NAME = "garmin_connect";

export function garmin(deps: Pick<Deps, "env" | "fetch" | "now">): Provider {
  const http = outbound(deps, REQUEST_TIMEOUT_MS);
  const setting = (name: string) => String(deps.env[name] ?? "").trim();

  const call = async (url: string, init?: RequestInit): Promise<Response> => {
    try {
      return await http(url, init);
    } catch {
      throw new PlatformError();
    }
  };

  const bearerGet = (url: string, accessToken: string) => call(url, { headers: { Authorization: `Bearer ${accessToken}` } });

  return {
    name: GARMIN_NAME,
    label: "Garmin Connect",
    requiredSettings: ["GARMIN_CLIENT_ID", "GARMIN_CLIENT_SECRET"],

    authorizeUrl({ redirectUri, state, codeChallenge }) {
      const query = new URLSearchParams({
        client_id: setting("GARMIN_CLIENT_ID"),
        response_type: "code",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        redirect_uri: redirectUri,
        state,
      });
      return `${AUTHORIZE_URL}?${query}`;
    },

    async exchangeCode({ code, codeVerifier, redirectUri }): Promise<PlatformTokens> {
      const response = await call(TOKEN_URL, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${setting("GARMIN_CLIENT_ID")}:${setting("GARMIN_CLIENT_SECRET")}`)}` },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        }),
      });
      if (!response.ok) throw new PlatformError(response.status);
      return readTokens((await response.json()) as TokenResponse, deps.now());
    },

    async identify(accessToken) {
      const response = await bearerGet(USER_ID_URL, accessToken);
      if (!response.ok) throw new PlatformError(response.status);
      const { userId } = (await response.json()) as { userId?: unknown };
      if (typeof userId !== "string" && typeof userId !== "number") throw new PlatformError(response.status);
      return String(userId);
    },

    async fetchPermissions(accessToken) {
      let response: Response;
      try {
        response = await bearerGet(PERMISSIONS_URL, accessToken);
      } catch {
        return null;
      }
      if (!response.ok) return null;
      const body = (await response.json().catch(() => null)) as { permissions?: unknown } | null;
      return Array.isArray(body?.permissions) ? body.permissions.map(String) : null;
    },

    capabilityMap({ permissions, needsReconnect, backfillDone }: ConnectionState): CapabilityMap {
      const status = (permission: string) => {
        if (needsReconnect) return "action_required";
        if (permissions !== null && !permissions.includes(permission)) return "action_required";
        return backfillDone ? "ready" : "syncing";
      };
      return {
        activities: status(ACTIVITY_EXPORT),
        activity_history: status(HISTORICAL_DATA_EXPORT),
        wellness: "unavailable",
        workouts: "unavailable",
      };
    },
  };
}

function readTokens(body: TokenResponse, now: number): PlatformTokens {
  const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, refresh_token_expires_in: refreshExpiresIn } = body;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresIn !== "number") {
    throw new PlatformError();
  }
  return {
    accessToken,
    refreshToken,
    accessExpiresAt: now + expiresIn,
    refreshExpiresAt: now + (typeof refreshExpiresIn === "number" ? refreshExpiresIn : REFRESH_FALLBACK_LIFETIME_SECONDS),
  };
}
