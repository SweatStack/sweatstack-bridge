import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeSweatStack } from "../fakes/sweatstack";
import { network } from "../support/network";

/**
 * What of the fake can't be checked against a real SweatStack yet, because SweatStack hasn't released
 * federation. These pin it to the contract; `test/fake-check` takes each over once it's released.
 */
describe("the fake's federation", () => {
  let fake: FakeSweatStack;
  let clientToken: string;

  const call = async (subject: string, state?: string) => {
    const response = await fake.fetch(
      new Request(`${fake.url}/api/v1/applications/${fake.appId}/connections/garmin_connect/${subject}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ capabilities: { activities: "syncing" }, state }),
      }),
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { user_id: string | null }).user_id;
  };

  beforeEach(async () => {
    fake = new FakeSweatStack();
    const token = await fake.fetch(
      new Request(`${fake.url}/api/v1/oauth/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa(`${fake.appId}:${fake.clientSecret}`)}` },
        body: new URLSearchParams({ grant_type: "client_credentials" }),
      }),
    );
    clientToken = ((await token.json()) as { access_token: string }).access_token;
  });

  it("creates the user at the call, for a new subject in a sign-in by nobody", async () => {
    const userId = await call("subject-a", fake.startFlow());
    expect(userId).toEqual(expect.any(String));
    expect(fake.users.has(userId as string)).toBe(true);
  });

  it("answers null until the browser is back, for a new subject in a connect from a Portal", async () => {
    const kari = fake.createUser({});
    const state = fake.startFlow({ startedBy: kari.id });
    expect(await call("subject-a", state)).toBeNull();
    expect(fake.browserReturns(state, "subject-a", { session: kari.id })).toBe("linked");
    expect(await call("subject-a")).toBe(kari.id);
  });

  it("keeps a new subject waiting when it has no valid state", async () => {
    expect(await call("subject-a")).toBeNull();
    expect(await call("subject-a", "not-a-state")).toBeNull();
    expect(fake.users.size).toBe(0);
  });

  it("links nothing when the returning browser doesn't hold the starter's session", async () => {
    const kari = fake.createUser({});
    const state = fake.startFlow({ startedBy: kari.id });
    await call("subject-a", state);
    expect(fake.browserReturns(state, "subject-a", { session: null })).toBe("refused");
    expect(await call("subject-a")).toBeNull();
  });

  it("refuses a subject another user holds, and moves nothing", async () => {
    const holder = await call("subject-a", fake.startFlow());
    const kari = fake.createUser({});
    const state = fake.startFlow({ startedBy: kari.id });
    expect(fake.browserReturns(state, "subject-a", { session: kari.id })).toBe("refused");
    expect(await call("subject-a")).toBe(holder);
  });

  it("knows the same subject after a disconnect", async () => {
    const userId = await call("subject-a", fake.startFlow());
    const removed = await fake.fetch(
      new Request(`${fake.url}/api/v1/applications/${fake.appId}/connections/garmin_connect/subject-a`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${clientToken}` },
      }),
    );
    expect(removed.status).toBe(204);
    expect(fake.connections.has("subject-a")).toBe(false);
    expect(await call("subject-a")).toBe(userId);
  });
});

describe("the fake's signed tokens", () => {
  const verify = async (fake: FakeSweatStack, token: string, typ: string) => {
    const jwks = createRemoteJWKSet(new URL(`${fake.url}/.well-known/jwks.json`), {
      [customFetch]: network({ [new URL(fake.url).host]: fake.fetch }),
    });
    return jwtVerify(token, jwks, { issuer: fake.url, audience: "https://bridge.test/oidc/garmin_connect", typ });
  };

  it("signs a software statement its JWKS verifies", async () => {
    const fake = new FakeSweatStack();
    const token = await fake.softwareStatement({ issuer: "https://bridge.test/oidc/garmin_connect", redirectUri: "https://r.test/" });
    const { payload } = await verify(fake, token, "software-statement+jwt");
    expect(payload).toMatchObject({ software_id: fake.appId, redirect_uris: ["https://r.test/"] });
  });

  it("signs a disconnect that names the user and the subject", async () => {
    const fake = new FakeSweatStack();
    const issuer = "https://bridge.test/oidc/garmin_connect";
    const token = await fake.disconnectEvent({ issuer, userId: "user-1", subject: "subject-a", provider: "garmin_connect" });
    const { payload } = await verify(fake, token, "secevent+jwt");
    expect(payload.sub).toBe("user-1");
    expect(payload.events).toEqual({
      "https://sweatstack.no/events/connection-disconnect": {
        provider: "garmin_connect",
        subject: { format: "iss_sub", iss: issuer, sub: "subject-a" },
      },
    });
  });
});
