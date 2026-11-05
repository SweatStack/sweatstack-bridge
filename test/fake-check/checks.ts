import { beforeAll, describe, expect, it } from "vitest";

/**
 * The calls the bridge makes, checked against a SweatStack: the fake in CI, a real one with
 * `npm run test:staging`. They're the only reason to believe the contract tests, because those only
 * prove the bridge matches the fake. Covers what's released: the client credentials grant,
 * the management API, declared connections and the upload relay.
 *
 * Safe to repeat against a real test app: it finds one user by its reference, and keeps sending one
 * file under one id.
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

    const upload = (token: string) => {
      const form = new FormData();
      form.append("files", new File([new Uint8Array([0])], "fake-check.fit"));
      form.append("external_id", REFERENCE);
      form.append("provider", PROVIDER);
      return t.fetch(`${t.url}/api/v1/activities/upload`, { method: "POST", headers: bearer(token), body: form });
    };

    beforeAll(async () => {
      t = target();
      const token = await clientTokenRequest(t.clientSecret);
      clientToken = ((await token.json()) as { access_token: string }).access_token;
      const user = await createUser();
      userId = ((await user.json()) as { id: string }).id;
      const mint = await t.fetch(`${users()}/${userId}/token`, { method: "POST", headers: bearer(clientToken) });
      userToken = ((await mint.json()) as { access_token: string }).access_token;
    });

    it("refuses a wrong client secret, as an OAuth error", async () => {
      const response = await clientTokenRequest("not-the-secret");
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: "invalid_client" });
    });

    it("gives a client token with no refresh token", async () => {
      const response = await clientTokenRequest(t.clientSecret);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ token_type: "Bearer", access_token: expect.any(String), expires_in: expect.any(Number) });
      expect(body.refresh_token ?? null).toBeNull();
    });

    it("finds a user by its reference, without a first name", async () => {
      const response = await createUser();
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: userId, external_reference: REFERENCE });
    });

    it("mints a user's token with no refresh token", async () => {
      const response = await t.fetch(`${users()}/${userId}/token`, { method: "POST", headers: bearer(clientToken) });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ access_token: expect.any(String), expires_in: expect.any(Number) });
      expect(body.refresh_token ?? null).toBeNull();
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
      expect(declared.status).toBe(200);
      expect(await declared.json()).toMatchObject({
        provider: PROVIDER,
        capabilities: ALL_UNAVAILABLE,
        connected_at: expect.any(String),
      });

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const removed = await t.fetch(connection(), { method: "DELETE", headers: bearer(clientToken) });
        expect(removed.status).toBe(204);
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

    it("takes a relayed file as a source, and the same id is the same source", async () => {
      const first = await upload(userToken);
      expect(first.status).toBe(202);
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
