import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, ISSUER, ORIGIN, PROVIDER, pathOf, resetDatabase, setSigningKey, world, type Client } from "../support/world";

const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };
const lars = { userId: "garmin-lars", permissions: ALL_PERMISSIONS };

/** Contract: "The authorization request", "The token endpoint", "The ID token". */
describe("the authorization request", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
  });

  it("sends the browser to the platform's consent, with its own PKCE and none of SweatStack's values", async () => {
    const response = await w.authorize(client);
    expect(response.status).toBe(302);
    const consent = new URL(response.headers.get("Location") as string);
    expect(consent.origin + consent.pathname).toBe("https://connect.garmin.com/oauth2Confirm");
    expect(consent.searchParams.get("client_id")).toBe(w.garmin.clientId);
    expect(consent.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback/${PROVIDER}`);
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("code_challenge")).not.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(consent.searchParams.get("state")).not.toBe("the-state");
  });

  it.each([
    ["an unknown client", { client_id: "stranger" }],
    ["a redirect URI that isn't exactly the registered one", { redirect_uri: "https://attacker.test/callback" }],
  ])("shows a page and redirects nowhere for %s", async (_name, overrides) => {
    const response = await w.authorize(client, overrides);
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it.each([
    ["a response type other than code", { response_type: "token" }, "unsupported_response_type"],
    ["a scope without openid", { scope: "profile" }, "invalid_scope"],
    ["no scope", { scope: null }, "invalid_scope"],
    ["no PKCE", { code_challenge: null, code_challenge_method: null }, "invalid_request"],
    ["plain PKCE", { code_challenge_method: "plain" }, "invalid_request"],
    ["a malformed challenge", { code_challenge: "short" }, "invalid_request"],
    ["prompt=none, because the bridge holds no session", { prompt: "none" }, "login_required"],
  ])("sends the standard error back for %s, with the state untouched", async (_name, overrides, error) => {
    const response = await w.authorize(client, overrides);
    expect(response.status).toBe(302);
    const back = new URL(response.headers.get("Location") as string);
    expect(back.origin + back.pathname).toBe(new URL(w.sweatstack.redirectUri()).origin + new URL(w.sweatstack.redirectUri()).pathname);
    expect(back.searchParams.get("error")).toBe(error);
    expect(back.searchParams.get("state")).toBe("the-state");
  });

  it("refuses a request without a state", async () => {
    const response = await w.authorize(client, { state: null });
    expect(new URL(response.headers.get("Location") as string).searchParams.get("error")).toBe("invalid_request");
  });

  it.each(["login", "select_account"])("goes to the consent for prompt=%s", async (prompt) => {
    const response = await w.authorize(client, { prompt });
    expect(new URL(response.headers.get("Location") as string).host).toBe("connect.garmin.com");
  });
});

describe("the platform's redirect", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
  });

  const startConsent = async () => {
    const state = w.sweatstack.startFlow();
    const started = await w.authorize(client, { state });
    return { state, consentUrl: started.headers.get("Location") as string };
  };

  it("sends a refusal back as access_denied, with the state untouched", async () => {
    const { state, consentUrl } = await startConsent();
    const response = await w.request(pathOf(w.garmin.deny(consentUrl)));
    const back = new URL(response.headers.get("Location") as string);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe(state);
    expect(back.searchParams.get("code")).toBeNull();
  });

  it.each([
    ["the token request", "token"],
    ["reading the account", "userId"],
  ] as const)("sends a failure of %s back as server_error", async (_name, failing) => {
    const { state, consentUrl } = await startConsent();
    w.garmin.failures[failing].push(503);
    const response = await w.request(pathOf(w.garmin.approve(consentUrl, kari)));
    const back = new URL(response.headers.get("Location") as string);
    expect(back.searchParams.get("error")).toBe("server_error");
    expect(back.searchParams.get("state")).toBe(state);
  });

  it("completes when the permissions aren't known yet, and doesn't call that a refusal", async () => {
    w.garmin.failures.permissions.push(403);
    const { sub } = await w.signIn(client, kari);
    const connection = w.sweatstack.connections.get(sub);
    expect(connection?.capabilities).toMatchObject({ activities: "syncing", activity_history: "syncing" });
  });

  it("shows its own page for a flow it doesn't know, since there's no state to send back", async () => {
    const response = await w.request(`/callback/${PROVIDER}?code=a-code&state=not-a-flow`);
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toMatch(/start again/);
  });

  it("shows that page for no state at all", async () => {
    expect((await w.request(`/callback/${PROVIDER}?code=a-code`)).status).toBe(400);
  });

  it("takes a flow once: a repeated redirect finds nothing", async () => {
    const { consentUrl } = await startConsent();
    const redirect = pathOf(w.garmin.approve(consentUrl, kari));
    expect((await w.request(redirect)).status).toBe(302);
    expect((await w.request(redirect)).status).toBe(400);
  });

  it("refuses a flow after its hour is over", async () => {
    const { consentUrl } = await startConsent();
    w.clock.now += 60 * 60 + 1;
    expect((await w.request(pathOf(w.garmin.approve(consentUrl, kari)))).status).toBe(400);
  });

  it("completes in another browser: nothing ties the flow to a cookie", async () => {
    const { consentUrl } = await startConsent();
    const response = await w.request(pathOf(w.garmin.approve(consentUrl, kari)), { headers: { Cookie: "" } });
    expect(new URL(response.headers.get("Location") as string).searchParams.get("code")).toEqual(expect.any(String));
  });

  it("gives a code and the untouched state", async () => {
    const flow = await w.consent(client, kari);
    expect(flow.code).toEqual(expect.any(String));
    expect(flow.landing.searchParams.get("state")).toBe(flow.state);
    expect(flow.landing.origin).toBe(new URL(w.sweatstack.url).origin);
  });
});

describe("the token endpoint", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
  });

  const form = (flow: { code: string | null; verifier: string }) => ({
    code: flow.code as string,
    redirect_uri: w.sweatstack.redirectUri(),
    code_verifier: flow.verifier,
  });

  it("gives an ID token that passes every check of SweatStack's relying party", async () => {
    const { claims, nonce } = await w.signIn(client, kari);
    expect(claims.iss).toBe(ISSUER);
    expect(claims.aud).toBe(client.clientId);
    expect(claims.nonce).toBe(nonce);
    expect(claims.sub).toEqual(expect.any(String));
    expect(claims.exp).toBeGreaterThan(claims.iat as number);
  });

  it("claims no email or name, because the platform gives neither", async () => {
    const { claims } = await w.signIn(client, kari);
    for (const claim of ["email", "email_verified", "name", "given_name", "family_name"]) expect(claims).not.toHaveProperty(claim);
  });

  it("answers as OAuth 2.0 requires, and never lets it be cached", async () => {
    const flow = await w.consent(client, kari);
    const response = await w.exchange(client, form(flow));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ token_type: "Bearer", access_token: expect.any(String), id_token: expect.any(String) });
  });

  it("gives the same subject to the same account, a different one to another, and never the platform's id", async () => {
    const first = await w.signIn(client, kari);
    const again = await w.signIn(client, kari);
    const other = await w.signIn(client, lars);
    expect(again.sub).toBe(first.sub);
    expect(other.sub).not.toBe(first.sub);
    expect(first.sub).not.toContain(kari.userId);
    expect(first.sub.length).toBeLessThanOrEqual(255);
  });

  it("takes a code once", async () => {
    const flow = await w.consent(client, kari);
    expect((await w.exchange(client, form(flow))).status).toBe(200);
    const second = await w.exchange(client, form(flow));
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: "invalid_grant" });
  });

  it.each([
    ["a wrong verifier", { code_verifier: "not-the-verifier" }],
    ["another redirect URI", { redirect_uri: "https://attacker.test/callback" }],
    ["an unknown code", { code: "not-a-code" }],
  ])("refuses %s", async (_name, overrides) => {
    const flow = await w.consent(client, kari);
    const response = await w.exchange(client, { ...form(flow), ...overrides });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a code after its ten minutes", async () => {
    const flow = await w.consent(client, kari);
    w.clock.now += 10 * 60 + 1;
    expect((await w.exchange(client, form(flow))).status).toBe(400);
  });

  it("refuses another grant type", async () => {
    const response = await w.exchange(client, { grant_type: "refresh_token" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  it("refuses a wrong secret, and leaves the code usable, so a stranger can't use it up", async () => {
    const flow = await w.consent(client, kari);
    const refused = await w.exchange(client, form(flow), "not-the-secret");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("WWW-Authenticate")).toMatch(/^Basic/);
    expect((await w.exchange(client, form(flow))).status).toBe(200);
  });

  it("refuses a request with no credentials", async () => {
    const response = await w.request(`/oidc/${PROVIDER}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code" }) });
    expect(response.status).toBe(401);
  });

  it("refuses a code issued to the client it has since replaced", async () => {
    const flow = await w.consent(client, kari);
    const replacement = await w.register();
    expect((await w.exchange(replacement, form(flow))).status).toBe(400);
  });

  it("answers 503 and keeps the code when there's no signing key yet", async () => {
    const flow = await w.consent(client, kari);
    await setSigningKey(false);
    expect((await w.exchange(client, form(flow))).status).toBe(503);
    await setSigningKey(true);
    expect((await w.exchange(client, form(flow))).status).toBe(200);
  });
});

describe("who the result belongs to", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
  });

  it("learns the user at once in a sign-in by nobody", async () => {
    const { sub } = await w.signIn(client, kari);
    const connection = w.sweatstack.connections.get(sub);
    expect(connection?.userId).toEqual(expect.any(String));
    expect(w.sweatstack.users.has(connection?.userId as string)).toBe(true);
  });

  it("states what the connection provides, from what was granted", async () => {
    const { sub } = await w.signIn(client, { userId: "garmin-partial", permissions: ["HISTORICAL_DATA_EXPORT"] });
    expect(w.sweatstack.connections.get(sub)?.capabilities).toEqual({
      activities: "action_required",
      activity_history: "syncing",
      wellness: "unavailable",
      workouts: "unavailable",
    });
  });

  it("finds the same user for a returning athlete", async () => {
    const first = await w.signIn(client, kari);
    const userId = w.sweatstack.connections.get(first.sub)?.userId;
    const usersBefore = w.sweatstack.users.size;
    await w.signIn(client, kari);
    expect(w.sweatstack.connections.get(first.sub)?.userId).toBe(userId);
    expect(w.sweatstack.users.size).toBe(usersBefore);
  });

  it("never creates a user or signs anyone in at SweatStack itself", async () => {
    await w.signIn(client, kari);
    const paths = w.sweatstack.calls.map((call) => `${call.method} ${call.path}`);
    expect(paths.some((path) => path.startsWith("POST") && path.endsWith("/users"))).toBe(false);
    expect(paths.some((path) => path.includes("/oauth/authorize"))).toBe(false);
  });

  it("completes a sign-in when the connection call fails: SweatStack makes the user on return", async () => {
    await resetDatabase({ withSigningKey: true });
    const failing = world({ intercept: (request) => (request.method === "PUT" ? new Response(null, { status: 503 }) : undefined) });
    const flow = await failing.signIn(await failing.register(), kari);
    expect(flow.sub).toEqual(expect.any(String));
  });

  it("completes a sign-in when SweatStack can't be reached", async () => {
    await resetDatabase({ withSigningKey: true });
    const down = world({
      intercept: (request) => {
        if (new URL(request.url).pathname.endsWith("jwks.json")) return undefined;
        throw new Error("SweatStack is down");
      },
    });
    const flow = await down.signIn(await down.register(), kari);
    expect(flow.sub).toEqual(expect.any(String));
  });

  it("gets a fresh token and tries again when SweatStack has stopped accepting the cached one", async () => {
    await resetDatabase({ withSigningKey: true });
    let refused = false;
    const expiring = world({
      intercept: (request) => {
        if (request.method === "PUT" && !refused) {
          refused = true;
          return new Response(null, { status: 401 });
        }
        return undefined;
      },
    });
    const { sub } = await expiring.signIn(await expiring.register(), kari);
    expect(refused).toBe(true);
    expect(expiring.sweatstack.connections.get(sub)?.userId).toEqual(expect.any(String));
    expect(expiring.sweatstack.calls.filter((call) => call.path === "/api/v1/oauth/token")).toHaveLength(2);
  });

  it("reuses the client token", async () => {
    await w.signIn(client, kari);
    await w.signIn(client, lars);
    expect(w.sweatstack.calls.filter((call) => call.path === "/api/v1/oauth/token")).toHaveLength(1);
  });

  describe("a connect from someone's Portal", () => {
    it("waits for the browser, without holding up the token response", async () => {
      const user = w.sweatstack.createUser({});
      const flow = await w.signIn(client, kari, { startedBy: user.id });
      // The token response is back, and SweatStack only links once it has that.
      expect(w.sweatstack.connections.get(flow.sub)?.userId).toBeNull();

      w.hooks.onSleep = () => w.sweatstack.browserReturns(flow.state, flow.sub, { session: user.id });
      await w.settled();
      expect(w.sweatstack.connections.get(flow.sub)?.userId).toBe(user.id);
      expect(w.sleeps.length).toBeGreaterThan(0);
    });

    it("stops asking after about five seconds, and leaves it to the job", async () => {
      const user = w.sweatstack.createUser({});
      await w.signIn(client, kari, { startedBy: user.id });
      await w.settled();
      const total = w.sleeps.reduce((sum, milliseconds) => sum + milliseconds, 0);
      expect(total).toBeGreaterThanOrEqual(4_000);
      expect(total).toBeLessThanOrEqual(6_000);
    });

    it("never gets a user when someone else's browser comes back: a forwarded link", async () => {
      const starter = w.sweatstack.createUser({});
      const flow = await w.signIn(client, kari, { startedBy: starter.id });
      expect(w.sweatstack.browserReturns(flow.state, flow.sub, { session: null })).toBe("refused");
      await w.settled();
      expect(w.sweatstack.connections.get(flow.sub)?.userId).toBeNull();
    });

    it("is the known user at once, when reconnecting", async () => {
      const first = await w.signIn(client, kari);
      const userId = w.sweatstack.connections.get(first.sub)?.userId;
      await w.signIn(client, kari, { startedBy: userId });
      await w.settled();
      expect(w.sleeps).toEqual([]);
      expect(w.sweatstack.connections.get(first.sub)?.userId).toBe(userId);
    });
  });
});
