import { Hono, type Context } from "hono";

/**
 * Garmin as SweatStack's hosted integration found it, on staging and in production: consent, the token
 * endpoint with HTTP Basic and PKCE, identity and permissions.
 */

export interface FakeGarminOptions {
  clientId?: string;
  clientSecret?: string;
}

export interface Account {
  userId: string;
  /** What the person grants. */
  permissions: string[];
}

interface Grant {
  account: Account;
  /** A refresh token that's been used once is spent, and using it again revokes the whole grant. */
  revoked: boolean;
}

interface PendingCode {
  account: Account;
  challenge: string;
  redirectUri: string;
}

const TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const REFRESH_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

/** Garmin allows up to about 100 days per backfill request. */
const LONGEST_BACKFILL_SECONDS = 100 * 24 * 60 * 60;

export const GARMIN_HOSTS = ["connect.garmin.com", "diauth.garmin.com", "apis.garmin.com"] as const;

export class FakeGarmin {
  readonly clientId: string;
  readonly clientSecret: string;

  /** Answers these instead of the real thing, one per call, for a test of a bad moment at Garmin. */
  readonly failures = {
    token: [] as number[],
    userId: [] as number[],
    permissions: [] as number[],
    file: [] as number[],
    backfill: [] as number[],
    registration: [] as number[],
  };
  /** Every refresh request that reached Garmin. */
  readonly refreshes: string[] = [];
  readonly downloads: string[] = [];
  /** Every backfill request Garmin answered with a yes. */
  readonly backfills: { userId: string; start: number; end: number }[] = [];
  /** Every backfill request that reached Garmin, whatever the answer. */
  readonly backfillRequests: { start: number; end: number }[] = [];
  /** Runs just before a deregistration is answered, for a test of what happens meanwhile. */
  beforeDeregistering: () => Promise<void> = async () => {};
  /** Accounts deregistered through `DELETE .../user/registration`. */
  readonly deregistered: string[] = [];
  /** While set, backfill requests wait for it: a test's way of holding Garmin up. */
  backfillGate: Promise<void> | undefined;

  private readonly app = new Hono();
  private readonly codes = new Map<string, PendingCode>();
  private readonly accessTokens = new Map<string, Grant>();
  private readonly refreshTokens = new Map<string, { grant: Grant; spent: boolean }>();
  private readonly files = new Map<string, { bytes: Uint8Array; token: string }>();
  private sequence = 0;

  constructor({ clientId = "test-garmin-id", clientSecret = "test-garmin-secret" }: FakeGarminOptions = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.routes();
  }

  readonly fetch = (request: Request): Promise<Response> | Response => this.app.fetch(request);

  /** A person approving on Garmin's consent screen. Returns where Garmin sends the browser. */
  approve(authorizeUrl: string, account: Account): string {
    const url = new URL(authorizeUrl);
    if (url.origin + url.pathname !== "https://connect.garmin.com/oauth2Confirm") throw new Error(`Not Garmin's consent screen: ${authorizeUrl}`);
    const query = url.searchParams;
    if (query.get("client_id") !== this.clientId) throw new Error("Garmin doesn't know this client");
    if (query.get("response_type") !== "code" || query.get("code_challenge_method") !== "S256") throw new Error("Garmin refuses this request");

    const redirectUri = query.get("redirect_uri") as string;
    const code = this.id("garmin-code");
    this.codes.set(code, { account, challenge: query.get("code_challenge") as string, redirectUri });
    const back = new URL(redirectUri);
    back.searchParams.set("code", code);
    back.searchParams.set("state", query.get("state") as string);
    return back.toString();
  }

  /** A person refusing on Garmin's consent screen. Returns where Garmin sends the browser. */
  deny(authorizeUrl: string): string {
    const query = new URL(authorizeUrl).searchParams;
    const back = new URL(query.get("redirect_uri") as string);
    back.searchParams.set("error", "access_denied");
    back.searchParams.set("state", query.get("state") as string);
    return back.toString();
  }

  /** A file becoming ready. Returns the ping Garmin posts, with the `token` parameter it adds on OAuth 2.0. */
  fileReady(account: Account, activityId: string, overrides: Record<string, unknown> = {}) {
    const token = this.id("file-token");
    this.files.set(activityId, { bytes: new TextEncoder().encode(`FIT-${activityId}`), token });
    return {
      userId: account.userId,
      summaryId: `${activityId}-file`,
      activityId,
      fileType: "FIT",
      startTimeInSeconds: 1_800_000_000,
      callbackURL: `https://apis.garmin.com/wellness-api/rest/activityFile?id=${activityId}&token=${token}`,
      ...overrides,
    };
  }

  /** The body Garmin posts when a person changes what they share. The bridge must not believe its list. */
  permissionsChanged(account: Account, permissions: string[] = account.permissions) {
    return { userPermissionsChange: [{ userId: account.userId, summaryId: `${account.userId}-permissions`, permissions }] };
  }

  /** The body Garmin posts when a person disconnects, or echoes after `DELETE .../user/registration`. */
  deregistration(account: Account) {
    return { deregistrations: [{ userId: account.userId }] };
  }

  /** Access tokens stop working now, whatever their expiry said. Refresh tokens carry on. */
  invalidateAccessTokens(): void {
    this.accessTokens.clear();
  }

  /** The person withdraws consent in Garmin Connect. */
  revokeEverything(): void {
    for (const { grant } of this.refreshTokens.values()) grant.revoked = true;
    this.accessTokens.clear();
  }

  private issueTokens(c: Context, grant: Grant) {
    const accessToken = this.id("garmin-access");
    const refreshToken = this.id("garmin-refresh");
    this.accessTokens.set(accessToken, grant);
    this.refreshTokens.set(refreshToken, { grant, spent: false });
    return c.json({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: TOKEN_LIFETIME_SECONDS,
      refresh_token_expires_in: REFRESH_LIFETIME_SECONDS,
    });
  }

  private routes(): void {
    this.app.post("/di-oauth2-service/oauth/token", async (c) => {
      const failure = this.failures.token.shift();
      if (failure !== undefined) return c.json({ error: "server_error" }, failure as 500);
      if (c.req.header("Authorization") !== `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`) {
        return c.json({ error: "invalid_client" }, 401);
      }
      const form = await c.req.parseBody();

      if (form.grant_type === "refresh_token") {
        const token = String(form.refresh_token);
        this.refreshes.push(token);
        const entry = this.refreshTokens.get(token);
        if (!entry || entry.spent || entry.grant.revoked) {
          if (entry) entry.grant.revoked = true;
          return c.json({ error: "invalid_grant" }, 400);
        }
        entry.spent = true;
        return this.issueTokens(c, entry.grant);
      }

      const pending = this.codes.get(String(form.code));
      this.codes.delete(String(form.code));
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(form.code_verifier)));
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      if (form.grant_type !== "authorization_code" || !pending || pending.redirectUri !== form.redirect_uri || pending.challenge !== challenge) {
        return c.json({ error: "invalid_grant" }, 400);
      }
      return this.issueTokens(c, { account: pending.account, revoked: false });
    });

    this.app.get("/wellness-api/rest/activityFile", (c) => {
      this.downloads.push(c.req.query("id") ?? "");
      const failure = this.failures.file.shift();
      if (failure !== undefined) return c.body(null, failure as 500);
      if (!this.bearer(c.req.header("Authorization"))) return c.body(null, 401);
      const file = this.files.get(c.req.query("id") ?? "");
      if (!file || file.token !== c.req.query("token")) return c.body(null, 404);
      return new Response(file.bytes);
    });

    this.app.get("/partner-gateway/rest/user/id", (c) => {
      const failure = this.failures.userId.shift();
      if (failure !== undefined) return c.body(null, failure as 500);
      const account = this.bearer(c.req.header("Authorization"));
      return account ? c.json({ userId: account.userId }) : c.body(null, 401);
    });

    this.app.get("/partner-gateway/rest/user/permissions", (c) => {
      const failure = this.failures.permissions.shift();
      if (failure !== undefined) return c.body(null, failure as 500);
      const account = this.bearer(c.req.header("Authorization"));
      return account ? c.json({ permissions: account.permissions }) : c.body(null, 401);
    });

    this.backfillRoute();
    this.registrationRoute();
  }

  private backfillRoute(): void {
    this.app.get("/wellness-api/rest/backfill/activities", async (c) => {
      const start = Number(c.req.query("summaryStartTimeInSeconds"));
      const end = Number(c.req.query("summaryEndTimeInSeconds"));
      this.backfillRequests.push({ start, end });
      await this.backfillGate;
      const failure = this.failures.backfill.shift();
      if (failure !== undefined) return c.body(null, failure as 500);
      const account = this.bearer(c.req.header("Authorization"));
      if (!account) return c.body(null, 401);
      if (!account.permissions.includes("HISTORICAL_DATA_EXPORT")) return c.text("Access denied, required HISTORICAL_DATA_EXPORT", 412);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || end - start > LONGEST_BACKFILL_SECONDS) return c.body(null, 400);
      if (this.backfills.some((window) => window.userId === account.userId && window.start === start && window.end === end)) return c.body(null, 409);
      this.backfills.push({ userId: account.userId, start, end });
      return c.body(null, 202);
    });
  }

  private registrationRoute(): void {
    this.app.delete("/partner-gateway/rest/user/registration", async (c) => {
      await this.beforeDeregistering();
      const failure = this.failures.registration.shift();
      if (failure !== undefined) return c.body(null, failure as 500);
      const header = c.req.header("Authorization") ?? "";
      const account = this.bearer(header);
      if (!account) return c.body(null, 401);
      this.deregistered.push(account.userId);
      const grant = this.accessTokens.get(header.slice("Bearer ".length)) as Grant;
      grant.revoked = true;
      return c.body(null, 204);
    });
  }

  private bearer(header: string | undefined): Account | undefined {
    if (!header?.startsWith("Bearer ")) return undefined;
    const grant = this.accessTokens.get(header.slice("Bearer ".length));
    return grant && !grant.revoked ? grant.account : undefined;
  }

  private id(kind: string): string {
    this.sequence += 1;
    return `${kind}-${this.sequence}`;
  }
}
