import type { Deps } from "../deps";
import { outbound } from "../http";
import {
  PlatformError,
  type Capability,
  type CapabilityMap,
  type ConnectionState,
  type DownloadedFile,
  type FileReady,
  type PlatformTokens,
  type Provider,
} from "./types";

const AUTHORIZE_URL = "https://connect.garmin.com/oauth2Confirm";
const TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const USER_ID_URL = "https://apis.garmin.com/partner-gateway/rest/user/id";
const PERMISSIONS_URL = "https://apis.garmin.com/partner-gateway/rest/user/permissions";

/** The only host a bearer token is ever sent to. */
const API_HOST = "apis.garmin.com";

/** The permission a person grants for each capability. */
const PERMISSIONS: Readonly<Record<Capability, string>> = {
  activities: "ACTIVITY_EXPORT",
  activity_history: "HISTORICAL_DATA_EXPORT",
  wellness: "HEALTH_EXPORT",
  workouts: "WORKOUT_IMPORT",
};

/** What this version of the bridge relays, whatever the app is approved for. */
const CARRIED: readonly Capability[] = ["activities", "activity_history"];

const OFFERS_SETTING = "GARMIN_APP_OFFERS";
const DEFAULT_OFFERS: readonly Capability[] = ["activities", "activity_history"];

const ACTIVITY_FILES_WEBHOOK = "activity-files";

const REQUEST_TIMEOUT_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** For a token response that doesn't say. Short of Garmin's 90 days, so the token gets refreshed early. */
const REFRESH_FALLBACK_LIFETIME_SECONDS = 80 * 24 * 60 * 60;

/** What a download needs later. The URL is kept byte for byte: it can carry a `token` parameter. */
interface FileReference {
  callbackUrl: string;
  activityId: string;
}

interface ActivityFilePing {
  userId?: unknown;
  activityId?: unknown;
  summaryId?: unknown;
  fileType?: unknown;
  callbackURL?: unknown;
  manual?: unknown;
}

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

  const offerNames = (): string[] => {
    const value = deps.env[OFFERS_SETTING];
    return typeof value === "string" ? value.split(",").map((name) => name.trim()).filter(Boolean) : [...DEFAULT_OFFERS];
  };
  const offered = (): ReadonlySet<Capability> =>
    new Set(offerNames().filter((name): name is Capability => Object.hasOwn(PERMISSIONS, name)));

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
    webhookKinds: [ACTIVITY_FILES_WEBHOOK],

    settingProblems() {
      return offerNames()
        .filter((name) => !Object.hasOwn(PERMISSIONS, name))
        .map((name) => `${OFFERS_SETTING} names "${name}", which isn't one of ${Object.keys(PERMISSIONS).join(", ")}`);
    },

    offeredCapabilities: offered,

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
      const offers = offered();
      // Without history on offer no backfill ever runs, so there's nothing to wait for.
      const settled = backfillDone || !offers.has("activity_history");
      const status = (capability: Capability) => {
        // Reconnecting can't change what the app itself isn't approved for, so nobody gets asked to.
        if (!CARRIED.includes(capability) || !offers.has(capability)) return "unavailable";
        if (needsReconnect) return "action_required";
        if (permissions !== null && !permissions.includes(PERMISSIONS[capability])) return "action_required";
        return settled ? "ready" : "syncing";
      };
      return {
        activities: status("activities"),
        activity_history: status("activity_history"),
        wellness: status("wellness"),
        workouts: status("workouts"),
      };
    },

    async refresh(refreshToken): Promise<PlatformTokens> {
      const response = await call(TOKEN_URL, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${setting("GARMIN_CLIENT_ID")}:${setting("GARMIN_CLIENT_SECRET")}`)}` },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        throw new PlatformError(response.status, typeof body?.error === "string" ? body.error : undefined);
      }
      return readTokens((await response.json()) as TokenResponse, deps.now());
    },

    parseWebhook(kind, body): FileReady[] {
      if (kind !== ACTIVITY_FILES_WEBHOOK) return [];
      const pings = (body as { activityFiles?: unknown } | null)?.activityFiles;
      if (!Array.isArray(pings)) return [];
      return (pings as ActivityFilePing[]).flatMap((ping) => {
        // The relay takes FIT and CSV, and Garmin's other formats aren't either. A manual activity has no file.
        if (ping.fileType !== "FIT" || ping.manual === true) return [];
        const { userId, activityId, callbackURL } = ping;
        if ((typeof userId !== "string" && typeof userId !== "number") || (typeof activityId !== "string" && typeof activityId !== "number") || typeof callbackURL !== "string") {
          return [];
        }
        const reference: FileReference = { callbackUrl: callbackURL, activityId: String(activityId) };
        return [{ platformUserId: String(userId), externalId: String(activityId), reference }];
      });
    },

    mayRelayFiles(permissions) {
      return permissions === null || permissions.includes(PERMISSIONS.activities);
    },

    isDownloadAllowed(reference) {
      const { callbackUrl } = reference as FileReference;
      try {
        const url = new URL(callbackUrl);
        return url.protocol === "https:" && url.hostname === API_HOST && url.port === "" && url.username === "" && url.password === "";
      } catch {
        return false;
      }
    },

    async downloadFile(accessToken, reference): Promise<DownloadedFile> {
      const { callbackUrl, activityId } = reference as FileReference;
      let response: Response;
      try {
        response = await outbound(deps, DOWNLOAD_TIMEOUT_MS)(callbackUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      } catch {
        throw new PlatformError();
      }
      if (!response.ok) throw new PlatformError(response.status);
      return { bytes: await response.arrayBuffer(), filename: `${activityId}.fit` };
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
