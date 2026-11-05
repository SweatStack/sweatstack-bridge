import { Hono, type Context } from "hono";
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from "jose";

/**
 * SweatStack as the self-hosted integration contract describes it: it answers the public API calls, records them, and
 * refuses what the real one refuses. `test/fake-check` holds it to the real thing for everything that's
 * released, so a difference found there is fixed here, in the one place.
 */

export interface FakeSweatStackOptions {
  url?: string;
  appId?: string;
  clientSecret?: string;
  /** Whether the platform is set to Self-hosted on the app's Data sources tab. */
  selfHosted?: boolean;
  /** Whether the card names an issuer, which the connection call by subject needs. */
  hasIssuer?: boolean;
  /** The app's default scopes. A new user gets a copy, and keeps it when the app's change later. */
  defaultScopes?: string[];
  /** The current time in seconds since the epoch. */
  now?: () => number;
}

interface Issued {
  /** The app for a client token, the user for a user's token. */
  sub: string;
  client: boolean;
  scopes: string[];
}

interface FakeUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  email_verified: boolean;
  external_reference: string | null;
  registered_at: string;
}

interface Declaration {
  capabilities: Record<string, string>;
  connected_at: string;
}

interface Connection extends Declaration {
  /** Null while it waits for the browser to come back. */
  userId: string | null;
  provider: string;
}

/** Who started a flow: nobody for a sign-in, a user for a connect from their Portal. */
type StartedBy = string | null;

const CAPABILITIES = ["activities", "activity_history", "wellness", "workouts"];
const STATUSES = ["ready", "syncing", "action_required", "unavailable"];
const TOKEN_LIFETIME_SECONDS = 900;
const MAX_FILES = 10;
const NOT_FOUND = { detail: "Not found." };

export class FakeSweatStack {
  readonly url: string;
  readonly appId: string;
  readonly clientSecret: string;
  selfHosted: boolean;
  hasIssuer: boolean;
  defaultScopes: string[];
  private readonly now: () => number;

  /** Everything sent to it, in order, for a test to assert on. */
  readonly calls: { method: string; path: string }[] = [];
  readonly users = new Map<string, FakeUser>();
  readonly uploads: { userId: string; externalId: string | null; provider: string | null; filename: string; content: string }[] = [];
  /** Files the relay refuses at the door, by external id, as it does a file it can't read. */
  readonly refusedFiles = new Set<string>();
  /** From the routes by user id, for an app with its own sign-in, as `user:provider`. */
  readonly declarations = new Map<string, Declaration>();
  /** From the connection call, by subject. */
  readonly connections = new Map<string, Connection>();
  /** Subject to user. Outlives a disconnect, so the same platform account is the same user. */
  readonly identities = new Map<string, string>();

  private readonly app = new Hono();
  private readonly tokens = new Map<string, Issued>();
  private readonly grants = new Map<string, string[]>();
  private readonly flows = new Map<string, StartedBy>();
  private readonly sources = new Map<string, string>();
  private signingKey?: Promise<{ privateKey: CryptoKey; publicJwk: JWK }>;
  private sequence = 0;

  constructor({
    url = "https://sweatstack.test",
    appId = "test-app",
    clientSecret = "test-client-secret",
    selfHosted = true,
    hasIssuer = true,
    defaultScopes = ["activities:write"],
    now = () => Math.floor(Date.now() / 1000),
  }: FakeSweatStackOptions = {}) {
    this.url = url;
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.selfHosted = selfHosted;
    this.hasIssuer = hasIssuer;
    this.defaultScopes = defaultScopes;
    this.now = now;
    this.routes();
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    this.calls.push({ method: request.method, path: pathname });
    return this.app.fetch(request);
  };

  /** Starts a flow, as SweatStack does before sending a browser to the issuer. Returns its `state`. */
  startFlow({ startedBy = null }: { startedBy?: StartedBy } = {}): string {
    const state = this.id("state");
    this.flows.set(state, startedBy);
    return state;
  }

  /**
   * The browser returning from the issuer, where SweatStack decides who the subject belongs to. Returns what it did.
   */
  browserReturns(state: string, subject: string, { session }: { session: string | null }): "linked" | "signed_in" | "refused" {
    const startedBy = this.flows.get(state);
    if (startedBy === undefined) return "refused";
    const holder = this.identities.get(subject);
    if (startedBy === null) {
      this.link(subject, holder ?? this.createUser({}).id);
      return "signed_in";
    }
    if (session !== startedBy) return "refused";
    if (holder !== undefined && holder !== startedBy) return "refused";
    this.link(subject, startedBy);
    return "linked";
  }

  createUser(fields: Partial<FakeUser>): FakeUser {
    const user: FakeUser = {
      id: this.id("user"),
      first_name: fields.first_name ?? null,
      last_name: fields.last_name ?? null,
      email: fields.email ?? null,
      email_verified: false,
      external_reference: fields.external_reference ?? null,
      registered_at: new Date(0).toISOString(),
    };
    this.users.set(user.id, user);
    this.grants.set(user.id, [...this.defaultScopes]);
    return user;
  }

  /** SweatStack's own callback, which it registers as the redirect URI. */
  redirectUri(provider = "garmin_connect"): string {
    return `${this.url}/api/v1/tenants/${this.appId}/integration-providers/${provider}/oauth2-authorization-callback`;
  }

  /** The software statement SweatStack signs when it registers itself. */
  async softwareStatement({
    issuer,
    redirectUri = this.redirectUri(),
    lifetimeSeconds = 5 * 60,
    softwareId = this.appId,
    typ = "software-statement+jwt",
    signedBy = this.url,
  }: {
    issuer: string;
    redirectUri?: string;
    lifetimeSeconds?: number;
    softwareId?: string;
    typ?: string;
    signedBy?: string;
  }): Promise<string> {
    const { privateKey, publicJwk } = await this.key();
    return new SignJWT({ software_id: softwareId, redirect_uris: [redirectUri], client_name: "SweatStack Sign-In for Test app" })
      .setProtectedHeader({ alg: "RS256", typ, kid: publicJwk.kid })
      .setIssuer(signedBy)
      .setAudience(issuer)
      .setJti(this.id("jti"))
      .setIssuedAt(this.now())
      .setExpirationTime(this.now() + lifetimeSeconds)
      .sign(privateKey);
  }

  /** The signed disconnect request, the same shape as SweatStack's. */
  async disconnectEvent({ issuer, userId, subject, provider }: { issuer: string; userId: string; subject: string; provider: string }): Promise<string> {
    const { privateKey, publicJwk } = await this.key();
    return new SignJWT({
      events: {
        "https://sweatstack.no/events/connection-disconnect": {
          provider,
          subject: { format: "iss_sub", iss: issuer, sub: subject },
        },
      },
    })
      .setProtectedHeader({ alg: "RS256", typ: "secevent+jwt", kid: publicJwk.kid })
      .setIssuer(this.url)
      .setAudience(issuer)
      .setSubject(userId)
      .setJti(this.id("jti"))
      .setIssuedAt(this.now())
      .sign(privateKey);
  }

  private routes(): void {
    const app = this.app;

    app.get("/.well-known/jwks.json", async (c) => c.json({ keys: [(await this.key()).publicJwk] }));

    app.post("/api/v1/oauth/token", async (c) => {
      const form = await c.req.parseBody();
      const [basicId, basicSecret] = basicCredentials(c);
      const clientId = basicId ?? form.client_id;
      const clientSecret = basicSecret ?? form.client_secret;
      if (form.grant_type !== "client_credentials") {
        return c.json({ error: "unsupported_grant_type" }, 400);
      }
      if (clientId !== this.appId || clientSecret !== this.clientSecret) {
        return c.json({ error: "invalid_client", error_description: "Invalid client credentials" }, 401);
      }
      return c.json(this.issue({ sub: this.appId, client: true, scopes: [] }));
    });

    const users = "/api/v1/applications/:app/users";

    app.post(users, async (c) => {
      const refused = this.refuseUnlessClient(c);
      if (refused) return refused;
      const body = await c.req.json<Partial<FakeUser>>();
      const existing = [...this.users.values()].find(
        (user) => body.external_reference != null && user.external_reference === body.external_reference,
      );
      if (existing) return c.json(existing, 200);
      return c.json(this.createUser(body), 201);
    });

    app.post(`${users}/:user/token`, (c) => {
      const refused = this.refuseUnlessClient(c);
      if (refused) return refused;
      const user = this.users.get(c.req.param("user"));
      if (!user) return c.json(NOT_FOUND, 404);
      return c.json(this.issue({ sub: user.id, client: false, scopes: this.grants.get(user.id) ?? [] }));
    });

    app.delete(`${users}/:user`, (c) => {
      const refused = this.refuseUnlessClient(c);
      if (refused) return refused;
      if (!this.users.delete(c.req.param("user"))) return c.json(NOT_FOUND, 404);
      return c.body(null, 204);
    });

    app.put(`${users}/:user/connections/:provider`, async (c) => {
      const refused = this.refuseUnlessClient(c);
      if (refused) return refused;
      const user = this.users.get(c.req.param("user"));
      if (!user) return c.json(NOT_FOUND, 404);
      if (!this.selfHosted) return c.json({ detail: "Not set to self-hosted." }, 409);
      const body = await c.req.json<{ capabilities?: Record<string, string> }>();
      const capabilities = body.capabilities;
      if (!validCapabilities(capabilities)) return c.json({ detail: "Invalid capabilities." }, 422);
      const provider = c.req.param("provider");
      const declaration = { capabilities, connected_at: new Date(0).toISOString() };
      this.declarations.set(`${user.id}:${provider}`, declaration);
      return c.json({ provider, ...declaration });
    });

    app.delete(`${users}/:user/connections/:provider`, (c) => {
      const refused = this.refuseUnlessClient(c);
      if (refused) return refused;
      const user = this.users.get(c.req.param("user"));
      if (!user) return c.json(NOT_FOUND, 404);
      if (!this.selfHosted) return c.json({ detail: "Not set to self-hosted." }, 409);
      this.declarations.delete(`${user.id}:${c.req.param("provider")}`);
      return c.body(null, 204);
    });

    const bySubject = "/api/v1/applications/:app/connections/:provider/:subject";

    // The connection call. Not released yet.
    app.put(bySubject, async (c) => {
      const refused = this.refuseUnlessClient(c);
      if (refused) return refused;
      if (!this.selfHosted || !this.hasIssuer) return c.json({ detail: "Not set to self-hosted with an issuer." }, 409);
      const body = await c.req.json<{ capabilities?: Record<string, string>; state?: string }>();
      const capabilities = body.capabilities;
      if (!validCapabilities(capabilities)) return c.json({ detail: "Invalid capabilities." }, 422);
      const subject = c.req.param("subject");
      const provider = c.req.param("provider");

      let userId = this.identities.get(subject) ?? null;
      if (userId === null && body.state !== undefined && this.flows.get(body.state) === null) {
        // A new subject in a sign-in started by nobody: the user exists from here on.
        userId = this.createUser({}).id;
        this.identities.set(subject, userId);
      }
      const existing = this.connections.get(subject);
      this.connections.set(subject, {
        userId,
        provider,
        capabilities,
        connected_at: existing?.connected_at ?? new Date(0).toISOString(),
      });
      const connection = this.connections.get(subject) as Connection;
      return c.json({ user_id: userId, provider, capabilities, connected_at: connection.connected_at });
    });

    app.delete(bySubject, (c) => {
      const refused = this.refuseUnlessClient(c);
      if (refused) return refused;
      if (!this.selfHosted || !this.hasIssuer) return c.json({ detail: "Not set to self-hosted with an issuer." }, 409);
      this.connections.delete(c.req.param("subject"));
      return c.body(null, 204);
    });

    app.post("/api/v1/activities/upload", async (c) => {
      const issued = this.bearer(c);
      if (!issued) return c.json({ detail: "No or invalid token provided" }, 401);
      if (issued.client) return c.json({ detail: "A client token can't be used here." }, 403);
      if (!issued.scopes.includes("activities:write")) {
        return c.json({ detail: `Insufficient scopes: ${JSON.stringify(issued.scopes)} does not contain activities:write.` }, 403);
      }
      const form = await c.req.formData();
      const files = form.getAll("files").filter((file): file is File => file instanceof File);
      if (files.length === 0 || files.length > MAX_FILES) return c.json({ detail: "Send 1 to 10 files." }, 400);
      const externalIds = form.getAll("external_id").map(String);
      const provider = form.get("provider");
      const sources = await Promise.all(
        files.map(async (file, index) => {
          const externalId = externalIds[index] ?? null;
          this.uploads.push({
            userId: issued.sub,
            externalId,
            provider: typeof provider === "string" ? provider : null,
            filename: file.name,
            content: await file.text(),
          });
          const refused = externalId !== null && this.refusedFiles.has(externalId);
          return { id: this.sourceId(issued.sub, externalId), status: refused ? "failed" : "processing" };
        }),
      );
      return c.json({ sources }, 202);
    });
  }

  private link(subject: string, userId: string): void {
    this.identities.set(subject, userId);
    const connection = this.connections.get(subject);
    if (connection) connection.userId = userId;
  }

  private refuseUnlessClient(c: Context): Response | undefined {
    const issued = this.bearer(c);
    if (!issued) return c.json({ detail: "No or invalid token provided" }, 401);
    if (!issued.client) return c.json({ detail: "This route takes a client token." }, 403);
    if (issued.sub !== c.req.param("app")) return c.json({ detail: "This client token belongs to another app." }, 403);
    return undefined;
  }

  private bearer(c: Context): Issued | undefined {
    const header = c.req.header("Authorization") ?? "";
    return header.startsWith("Bearer ") ? this.tokens.get(header.slice("Bearer ".length)) : undefined;
  }

  private issue(issued: Issued) {
    const accessToken = this.id("token");
    this.tokens.set(accessToken, issued);
    return { access_token: accessToken, token_type: "Bearer", expires_in: TOKEN_LIFETIME_SECONDS };
  }

  private sourceId(userId: string, externalId: string | null): string {
    if (externalId === null) return this.id("source");
    const key = `${userId}:${externalId}`;
    const id = this.sources.get(key) ?? this.id("source");
    this.sources.set(key, id);
    return id;
  }

  private key() {
    this.signingKey ??= (async () => {
      const { privateKey, publicKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
      return { privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid: "fake-sweatstack", alg: "RS256", use: "sig" } };
    })();
    return this.signingKey;
  }

  private id(kind: string): string {
    this.sequence += 1;
    return `${kind}-${this.sequence}`;
  }
}

function basicCredentials(c: Context): [string | undefined, string | undefined] {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Basic ")) return [undefined, undefined];
  const [id, secret] = atob(header.slice("Basic ".length)).split(":");
  return [id, secret];
}

function validCapabilities(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).every(([key, status]) => CAPABILITIES.includes(key) && STATUSES.includes(status as string));
}
