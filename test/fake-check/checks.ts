import { beforeAll, describe, expect, it } from "vitest";

/**
 * The calls the bridge makes, checked against a SweatStack: the fake in CI, a real one with
 * `npm run test:staging`. They're the only reason to believe the contract tests, because those only
 * prove the bridge matches the fake. Covers what's released: the client credentials grant,
 * the management API, declared connections and the upload relay.
 *
 * Safe to repeat against a real test app: it replaces its one test user, found by its reference, at
 * the start of each run.
 */
export interface Target {
  url: string;
  appId: string;
  clientSecret: string;
  fetch: typeof fetch;
}

const PROVIDER = "garmin_connect";
const REFERENCE = "bridge-fake-check";
const ALL_UNAVAILABLE = { activities: "unavailable", activity_history: "unavailable", wellness: "unavailable", workouts: "unavailable" };

/** The body of a setup call, or a failure that says what the server answered. */
async function setup<T>(what: string, response: Response): Promise<T> {
  const body = await response.text();
  if (!response.ok) throw new Error(`Couldn't get ${what}: ${response.status} ${body.slice(0, 500)}`);
  return JSON.parse(body) as T;
}

/** Checks the status, and on a mismatch fails with what the server said, which is usually the reason. */
async function expectStatus(response: Response, status: number): Promise<void> {
  if (response.status === status) return;
  expect(`${response.status} ${(await response.text()).slice(0, 500)}`).toBe(String(status));
}

export function checks(name: string, target: () => Target): void {
  describe(`SweatStack API: ${name}`, () => {
    let t: Target;
    let clientToken: string;
    let userId: string;
    let userToken: string;

    const clientTokenRequest = (secret: string) =>
      t.fetch(`${t.url}/api/v1/oauth/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${t.appId}:${secret}`)}` },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      });

    const users = () => `${t.url}/api/v1/applications/${t.appId}/users`;
    const connection = () => `${users()}/${userId}/connections/${PROVIDER}`;
    const bearer = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

    const createUser = () =>
      t.fetch(users(), {
        method: "POST",
        headers: bearer(clientToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ external_reference: REFERENCE }),
      });

    const mint = (token: string, body: object) =>
      t.fetch(`${users()}/${userId}/token`, { method: "POST", headers: bearer(token, { "Content-Type": "application/json" }), body: JSON.stringify(body) });

    const upload = (token: string) => {
      const form = new FormData();
      form.append("files", new File([new Uint8Array([0])], "fake-check.fit"));
      form.append("external_id", REFERENCE);
      form.append("provider", PROVIDER);
      return t.fetch(`${t.url}/api/v1/activities/upload`, { method: "POST", headers: bearer(token), body: form });
    };

    // Stops here if the setup fails: every check below needs these, and would only fail confusingly.
    beforeAll(async () => {
      t = target();
      ({ access_token: clientToken } = await setup<{ access_token: string }>("a client token", await clientTokenRequest(t.clientSecret)));
      const { id: previous } = await setup<{ id: string }>("the test user", await createUser());
      const deleted = await t.fetch(`${users()}/${previous}`, { method: "DELETE", headers: bearer(clientToken) });
      if (!deleted.ok) throw new Error(`Couldn't replace the test user: ${deleted.status}`);
      ({ id: userId } = await setup<{ id: string }>("the test user", await createUser()));
      ({ access_token: userToken } = await setup<{ access_token: string }>(
        "a token for the test user",
        await mint(clientToken, { scope: "activities:write" }),
      ));
    });

    it("refuses a wrong client secret, as an OAuth error", async () => {
      const response = await clientTokenRequest("not-the-secret");
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
    });

    it("gives a client token with no refresh token", async () => {
      const response = await clientTokenRequest(t.clientSecret);
      await expectStatus(response, 200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ token_type: "Bearer", access_token: expect.any(String), expires_in: expect.any(Number) });
      expect(body.refresh_token ?? null).toBeNull();
    });

    it("finds a user by its reference, without a first name", async () => {
      const response = await createUser();
      await expectStatus(response, 200);
      expect(await response.json()).toMatchObject({ id: userId, external_reference: REFERENCE });
    });

    it("mints a user's token with no refresh token", async () => {
      const response = await t.fetch(`${users()}/${userId}/token`, { method: "POST", headers: bearer(clientToken) });
      await expectStatus(response, 200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ access_token: expect.any(String), expires_in: expect.any(Number) });
      expect(body.refresh_token ?? null).toBeNull();
    });

    it("mints a token holding only the scope it was asked for, from the user's first moment", async () => {
      const response = await mint(clientToken, { scope: "activities:write" });
      await expectStatus(response, 200);
      expect(await response.json()).toMatchObject({ access_token: expect.any(String) });
    });

    it("refuses a token holding more than the app's default scopes", async () => {
      expect((await mint(clientToken, { scope: "offline_access" })).status).toBe(400);
    });

    it("answers 404 for a user it doesn't know", async () => {
      const response = await t.fetch(`${users()}/no-such-user/token`, { method: "POST", headers: bearer(clientToken) });
      expect(response.status).toBe(404);
    });

    it("keeps user tokens off the management API, and client tokens off user routes", async () => {
      const management = await t.fetch(`${users()}/${userId}/token`, { method: "POST", headers: bearer(userToken) });
      expect(management.status).toBe(403);
      expect((await upload(clientToken)).status).toBe(403);
    });

    it("refuses a call with no token", async () => {
      expect((await t.fetch(`${users()}/${userId}/token`, { method: "POST" })).status).toBe(401);
    });

    it("declares a connection and removes it, and removing it twice is safe", async () => {
      const declared = await t.fetch(connection(), {
        method: "PUT",
        headers: bearer(clientToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ capabilities: ALL_UNAVAILABLE }),
      });
      await expectStatus(declared, 200);
      expect(await declared.json()).toMatchObject({
        provider: PROVIDER,
        capabilities: ALL_UNAVAILABLE,
        connected_at: expect.any(String),
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const removed = await t.fetch(connection(), { method: "DELETE", headers: bearer(clientToken) });
        await expectStatus(removed, 204);
      }
    });

    it("refuses a capability it doesn't know", async () => {
      const response = await t.fetch(connection(), {
        method: "PUT",
        headers: bearer(clientToken, { "Content-Type": "application/json" }),
        body: JSON.stringify({ capabilities: { activities: "excellent" } }),
      });
      expect(response.status).toBe(422);
    });

    describe("the connection call by subject", () => {
      const subject = "bridge-fake-check-subject";
      const bySubject = () => `${t.url}/api/v1/applications/${t.appId}/connections/${PROVIDER}/${subject}`;
      const put = (body: object) =>
        t.fetch(bySubject(), {
          method: "PUT",
          headers: bearer(clientToken, { "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });

      // The test app may be set up without an issuer, and then this call can only answer 409.
      const skipWithoutIssuer = async (context: { skip: (note?: string) => void }) => {
        const response = await put({ capabilities: ALL_UNAVAILABLE });
        if (response.status === 409) context.skip("the test app's card has no issuer");
      };

      it("answers null for a subject it doesn't know, with no state or an invalid one", async (context) => {
        await skipWithoutIssuer(context);
        for (const body of [{}, { state: "not-a-state" }]) {
          const response = await put({ capabilities: ALL_UNAVAILABLE, ...body });
          await expectStatus(response, 200);
          expect(await response.json()).toMatchObject({ user_id: null, provider: PROVIDER, capabilities: ALL_UNAVAILABLE });
        }
      });

      it("refuses a capability it doesn't know", async (context) => {
        await skipWithoutIssuer(context);
        expect((await put({ capabilities: { activities: "excellent" } })).status).toBe(422);
      });

      it("removes a connection, and removing it twice is safe", async (context) => {
        await skipWithoutIssuer(context);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const removed = await t.fetch(bySubject(), { method: "DELETE", headers: bearer(clientToken) });
          await expectStatus(removed, 204);
        }
      });

      it("keeps user tokens off it", async (context) => {
        await skipWithoutIssuer(context);
        const response = await t.fetch(bySubject(), { method: "DELETE", headers: bearer(userToken) });
        expect(response.status).toBe(403);
      });
    });

    it("takes a relayed file as a source, and the same id is the same source", async () => {
      const first = await upload(userToken);
      await expectStatus(first, 202);
      const { sources } = (await first.json()) as { sources: { id: string; status: string }[] };
      expect(sources).toHaveLength(1);
      expect(sources[0]?.id).toEqual(expect.any(String));
      expect(["processing", "failed"]).toContain(sources[0]?.status);

      const again = await upload(userToken);
      const repeated = (await again.json()) as { sources: { id: string }[] };
      expect(repeated.sources[0]?.id).toBe(sources[0]?.id);
    });
  });
}
