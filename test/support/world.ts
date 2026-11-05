import { env } from "cloudflare:test";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { generateSigningKey } from "../../scripts/lib/signing-key.mjs";
import { createApp } from "../../src/app";
import type { Env } from "../../src/config";
import type { Deps } from "../../src/deps";
import { sweep } from "../../src/inbox/sweeper";
import { FakeGarmin, GARMIN_HOSTS, type Account } from "../fakes/garmin";
import { FakeSweatStack, type FakeSweatStackOptions } from "../fakes/sweatstack";
import { network, type Handler } from "./network";

export const ORIGIN = "https://bridge.test";
export const PROVIDER = "garmin_connect";
export const ISSUER = `${ORIGIN}/oidc/${PROVIDER}`;
export const ALL_PERMISSIONS = ["ACTIVITY_EXPORT", "HISTORICAL_DATA_EXPORT"];

/** Made once: generating an RSA key is slow, and no test needs its own. */
let signingKey: Promise<string> | undefined;

/** Whether the deploy script has made the signing key, for a test of what comes before that. */
export async function setSigningKey(present: boolean): Promise<void> {
  await env.DB.prepare("DELETE FROM meta WHERE key = 'signing_key'").run();
  if (present) {
    signingKey ??= generateSigningKey();
    await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('signing_key', ?)").bind(await signingKey).run();
  }
}

/** A clean slate, with the secrets the first migration made left in place. */
export async function resetDatabase({ withSigningKey }: { withSigningKey: boolean }): Promise<void> {
  await env.DB.batch(["clients", "flows", "connections", "tokens", "inbox"].map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  await setSigningKey(withSigningKey);
}

export interface WorldOptions {
  sweatstack?: FakeSweatStackOptions;
  /** Settings on top of the complete ones. */
  settings?: Record<string, string>;
  /** Answers a call instead of the fake, for a test of a bad moment at SweatStack. Undefined lets it through. */
  intercept?: (request: Request) => Response | undefined | Promise<Response | undefined>;
}

export interface Client {
  clientId: string;
  clientSecret: string;
}

/**
 * The bridge between a fake SweatStack and a fake Garmin, and SweatStack's side of a sign-in: the same
 * requests and the same checks as its relying party.
 */
export function world({ sweatstack: sweatstackOptions, settings: extraSettings, intercept }: WorldOptions = {}) {
  const clock = { now: 1_800_000_000 };
  const sweatstack = new FakeSweatStack({ now: () => clock.now, ...sweatstackOptions });
  const garmin = new FakeGarmin();
  const settings = {
    SWEATSTACK_URL: sweatstack.url,
    SWEATSTACK_APP_ID: sweatstack.appId,
    SWEATSTACK_CLIENT_SECRET: sweatstack.clientSecret,
    GARMIN_CLIENT_ID: garmin.clientId,
    GARMIN_CLIENT_SECRET: garmin.clientSecret,
    BACKFILL_DAYS: "90",
    ...extraSettings,
  };
  const background: Promise<unknown>[] = [];
  const hooks: { onSleep: () => void } = { onSleep: () => {} };
  const sleeps: number[] = [];

  /** Whatever reached a host that isn't Garmin's or SweatStack's: a forged ping's address. */
  const foreignCalls: { url: string; authorization: string | null }[] = [];
  const elsewhere: Handler = (request) => {
    foreignCalls.push({ url: request.url, authorization: request.headers.get("Authorization") });
    return new Response("not a file");
  };
  const hosts: Record<string, Handler> = {
    [new URL(sweatstack.url).host]: async (request) => (await intercept?.(request.clone())) ?? sweatstack.fetch(request),
    ...Object.fromEntries(GARMIN_HOSTS.map((host) => [host, garmin.fetch])),
  };

  const bridgeEnv: Env = { DB: env.DB, ...settings };
  const deps: Deps = {
    env: bridgeEnv,
    fetch: network(hosts, elsewhere),
    now: () => clock.now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      hooks.onSleep();
    },
    waitUntil: (work) => {
      background.push(work);
    },
  };
  const app = createApp(deps);

  const request = (path: string, init?: RequestInit) => app.request(`${ORIGIN}${path}`, init, bridgeEnv);
  const discoveryPath = `/oidc/${PROVIDER}/.well-known/openid-configuration`;

  const postRegistration = (body: unknown) =>
    request(`/oidc/${PROVIDER}/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  /** SweatStack saving the Data sources card: reads discovery, and registers itself with a statement. */
  const register = async (): Promise<Client> => {
    const response = await postRegistration({ software_statement: await sweatstack.softwareStatement({ issuer: ISSUER }), redirect_uris: [sweatstack.redirectUri()] });
    if (response.status !== 201) throw new Error(`Registration failed: ${response.status}`);
    const { client_id: clientId, client_secret: clientSecret } = (await response.json()) as { client_id: string; client_secret: string };
    return { clientId, clientSecret };
  };

  const pkce = async () => {
    const verifier = crypto.randomUUID() + crypto.randomUUID();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    return { verifier, challenge };
  };

  const authorizationQuery = (client: Client, overrides: Record<string, string | null>) => {
    const values: Record<string, string | null> = {
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: sweatstack.redirectUri(),
      scope: "openid",
      state: "the-state",
      nonce: "the-nonce",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      ...overrides,
    };
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(values)) if (value !== null) query.set(name, value);
    return query;
  };

  const authorize = (client: Client, overrides: Record<string, string | null> = {}) =>
    request(`/oidc/${PROVIDER}/authorize?${authorizationQuery(client, overrides)}`);

  /** Runs everything the bridge left running behind its answers, including what that work started. */
  const settled = async () => {
    while (background.length > 0) await Promise.all(background.splice(0));
  };

  /** Garmin posting to a webhook. The path comes from `npm run urls` in real life. */
  const webhook = async (kind: string, body: unknown, { secret }: { secret?: string } = {}) => {
    const stored = await env.DB.prepare("SELECT value FROM meta WHERE key = 'webhook_secret'").first<{ value: string }>();
    return request(`/${PROVIDER}/${secret ?? stored?.value}/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  };

  /** A ping about these files, and everything it set off. */
  const ping = async (...files: unknown[]) => {
    const response = await webhook("activity-files", { activityFiles: files });
    await settled();
    return response;
  };

  /** One run of the cron. */
  const cron = async () => {
    await sweep(deps);
    await settled();
  };

  const exchange = (client: Client, form: Record<string, string>, secret = client.clientSecret) =>
    request(`/oidc/${PROVIDER}/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${client.clientId}:${secret}`)}` },
      body: new URLSearchParams({ grant_type: "authorization_code", ...form }),
    });

  /** Verifies an ID token as SweatStack's relying party does. */
  const verifyIdToken = async (client: Client, idToken: string, nonce: string): Promise<JWTPayload> => {
    const discovered = (await (await request(discoveryPath)).json()) as { issuer: string; jwks_uri: string };
    const keys = (await (await request(new URL(discovered.jwks_uri).pathname)).json()) as JSONWebKeySet;
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys), {
      algorithms: ["RS256"],
      issuer: discovered.issuer,
      audience: client.clientId,
      requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
      currentDate: new Date(clock.now * 1000),
    });
    if (payload.nonce !== nonce) throw new Error("The ID token belongs to another flow");
    return payload;
  };

  /** The first half of a sign-in: from SweatStack's redirect to the code it gets back. */
  const consent = async (client: Client, account: Account, { startedBy = null }: { startedBy?: string | null } = {}) => {
    const state = sweatstack.startFlow({ startedBy });
    const { verifier, challenge } = await pkce();
    const started = await authorize(client, { state, nonce: `nonce-${state}`, code_challenge: challenge });
    if (started.status !== 302) throw new Error(`Authorize failed: ${started.status}`);
    const back = await request(pathOf(garmin.approve(started.headers.get("Location") as string, account)));
    if (back.status !== 302) throw new Error(`The callback failed: ${back.status}`);
    const landing = new URL(back.headers.get("Location") as string);
    return { state, verifier, nonce: `nonce-${state}`, code: landing.searchParams.get("code"), landing };
  };

  /** A whole sign-in, through to a verified ID token. */
  const signIn = async (client: Client, account: Account, options: { startedBy?: string | null } = {}) => {
    const flow = await consent(client, account, options);
    const response = await exchange(client, { code: flow.code as string, redirect_uri: sweatstack.redirectUri(), code_verifier: flow.verifier });
    if (response.status !== 200) throw new Error(`The token request failed: ${response.status}`);
    const { id_token: idToken } = (await response.json()) as { id_token: string };
    const claims = await verifyIdToken(client, idToken, flow.nonce);
    return { ...flow, claims, sub: claims.sub as string };
  };

  return { sweatstack, garmin, clock, hooks, sleeps, foreignCalls, webhook, ping, cron, request, discoveryPath, postRegistration, register, authorize, exchange, consent, signIn, settled, verifyIdToken };
}

export function pathOf(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname + parsed.search;
}
