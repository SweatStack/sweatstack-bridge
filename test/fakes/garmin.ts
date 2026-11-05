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

export const GARMIN_HOSTS = ["connect.garmin.com", "diauth.garmin.com", "apis.garmin.com"] as const;

export class FakeGarmin {
  readonly clientId: string;
  readonly clientSecret: string;

  /** Answers these instead of the real thing, one per call, for a test of a bad moment at Garmin. */
  readonly failures = { token: [] as number[], userId: [] as number[], permissions: [] as number[], file: [] as number[] };
  /** Every refresh request that reached Garmin. */
  readonly refreshes: string[] = [];
  readonly downloads: string[] = [];

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
