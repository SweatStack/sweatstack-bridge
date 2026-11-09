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

/** A user token for `userId`, minted as the bridge does: a client token first. */
async function mint(fake: FakeSweatStack, userId: string, scope?: string): Promise<Response> {
  const basic = `Basic ${btoa(`${fake.appId}:${fake.clientSecret}`)}`;
  const client = await fake.fetch(
    new Request(`${fake.url}/api/v1/oauth/token`, {
      method: "POST",
      headers: { Authorization: basic },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    }),
  );
  const { access_token: clientToken } = (await client.json()) as { access_token: string };
  return fake.fetch(
    new Request(`${fake.url}/api/v1/applications/${fake.appId}/users/${userId}/token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${clientToken}`, "Content-Type": "application/json" },
      ...(scope === undefined ? {} : { body: JSON.stringify({ scope }) }),
    }),
  );
}

/** Relays one file as `userId`, with any other form fields given. */
async function relay(fake: FakeSweatStack, userId: string, fields: Record<string, string> = {}): Promise<Response> {
  const { access_token: userToken } = (await (await mint(fake, userId)).json()) as { access_token: string };
  const form = new FormData();
  form.append("files", new File([new Uint8Array([0])], "a.fit"));
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return fake.fetch(
    new Request(`${fake.url}/api/v1/activities/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}` },
      body: form,
    }),
  );
}

describe("the fake's scopes", () => {
  it("refuses a relay without activities:write, and a change of the app's scopes reaches a user at the next token", async () => {
    const fake = new FakeSweatStack({ defaultScopes: [] });
    const early = fake.createUser({});
    expect((await relay(fake, early.id)).status).toBe(403);

    fake.defaultScopes = ["activities:write"];
    expect((await relay(fake, early.id)).status).toBe(202);
  });

  it("mints a part of the app's scopes on request, never more, and never offline_access", async () => {
    const fake = new FakeSweatStack({ defaultScopes: ["activities:write", "activities:read", "offline_access"] });
    const { id } = fake.createUser({});
    expect((await mint(fake, id, "activities:write")).status).toBe(200);
    expect(fake.mintedScopes.at(-1)).toEqual(["activities:write"]);
    expect((await mint(fake, id)).status).toBe(200);
    expect(fake.mintedScopes.at(-1)).toEqual(["activities:write", "activities:read"]);
    expect((await mint(fake, id, "sharing:write")).status).toBe(400);
    expect((await mint(fake, id, "offline_access")).status).toBe(400);
  });
});

/** The platform on an upload, as SweatStack takes it from its release that separates writer and platform. */
describe("the fake's upload", () => {
  it("records the platform and echoes it, with the writer the token makes", async () => {
    const fake = new FakeSweatStack();
    const { id } = fake.createUser({});
    const response = await relay(fake, id, { external_id: "1001", platform: "garmin_connect" });
    expect(response.status).toBe(202);
    const { sources } = (await response.json()) as { sources: Record<string, unknown>[] };
    expect(sources[0]).toMatchObject({ writer: "application", application_id: fake.appId, platform: "garmin_connect" });
    expect(fake.uploads[0]?.platform).toBe("garmin_connect");
  });

  it("refuses a platform that isn't a name, and stores nothing", async () => {
    const fake = new FakeSweatStack();
    const { id } = fake.createUser({});
    expect((await relay(fake, id, { platform: "Garmin Connect" })).status).toBe(422);
    expect(fake.uploads).toEqual([]);
  });

  it("ignores provider, which SweatStack no longer reads", async () => {
    const fake = new FakeSweatStack();
    const { id } = fake.createUser({});
    const response = await relay(fake, id, { provider: "garmin_connect" });
    expect(response.status).toBe(202);
    const { sources } = (await response.json()) as { sources: Record<string, unknown>[] };
    expect(sources[0]).toMatchObject({ platform: null });
    expect(sources[0]).not.toHaveProperty("provider");
    expect(fake.uploads[0]?.platform).toBeNull();
  });
});

/** What `test/fake-check` can't set up on a real SweatStack: a day someone else wrote first. */
describe("the fake's dailies", () => {
  const write = async (fake: FakeSweatStack, userId: string, value: number) => {
    const { access_token: token } = (await (await mint(fake, userId, "wellness:write")).json()) as { access_token: string };
    return fake.fetch(
      new Request(`${fake.url}/api/v1/dailies/body_mass`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ date: "2026-11-08", value, platform: "garmin_connect" }),
      }),
    );
  };

  it("lets an app's write replace what the athlete wrote", async () => {
    const fake = new FakeSweatStack({ defaultScopes: ["wellness:write"] });
    const { id } = fake.createUser({});
    fake.storeDaily(id, { measure: "body_mass", date: "2026-11-08", value: 70, writer: "athlete", application_id: null, platform: null });
    expect(await (await write(fake, id, 71)).json()).toMatchObject({ value: 71, writer: "application", platform: "garmin_connect" });
    expect(fake.daily(id, "body_mass", "2026-11-08")).toMatchObject({ value: 71, writer: "application", application_id: fake.appId });
  });

  it("keeps the writer of a day that already holds the value", async () => {
    const fake = new FakeSweatStack({ defaultScopes: ["wellness:write"] });
    const { id } = fake.createUser({});
    fake.storeDaily(id, { measure: "body_mass", date: "2026-11-08", value: 70, writer: "athlete", application_id: null, platform: null });
    expect(await (await write(fake, id, 70)).json()).toMatchObject({ value: 70, writer: "athlete", platform: null });
    expect(fake.dailyWrites).toEqual([]);
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
