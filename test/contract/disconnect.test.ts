import { generateKeyPair } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, ISSUER, resetDatabase, world, type Client } from "../support/world";

const FIVE_MINUTES = 5 * 60;

let w: ReturnType<typeof world>;
let client: Client;
const kari = { userId: "garmin-kari", permissions: [...ALL_PERMISSIONS] };

/** Someone with a Garmin connection, and everything their sign-in started finished. */
const connected = async () => {
  const { sub } = await w.signIn(client, kari);
  await w.settled();
  const userId = w.sweatstack.connections.get(sub)?.userId as string;
  return { sub, userId };
};

const declaredDeletes = () => w.sweatstack.calls.filter((call) => call.method === "DELETE" && call.path.includes("/connections/"));

beforeEach(async () => {
  await resetDatabase({ withSigningKey: true });
  w = world();
  client = await w.register();
});

/** Contract: "To give the Portal a Disconnect button, name a `sweatstack_disconnect_endpoint` in your discovery document." */
describe("discovery", () => {
  it("names the disconnect endpoint", async () => {
    const response = await w.request(w.discoveryPath);
    expect(await response.json()).toMatchObject({ sweatstack_disconnect_endpoint: `${ISSUER}/disconnect` });
  });
});

/** Contract: "Deregister the user at the platform, delete their tokens, and answer `2xx`." */
describe("a disconnect", () => {
  it("deregisters at Garmin, forgets the connection, and answers 2xx", async () => {
    const { sub, userId } = await connected();
    expect((await w.disconnect(sub, userId)).status).toBe(204);
    expect(w.garmin.deregistered).toEqual([kari.userId]);

    // The tokens are gone: a file that arrives now finds nobody to act for.
    const downloads = w.garmin.downloads.length;
    await w.ping(w.garmin.fileReady(kari, "1"));
    expect(w.garmin.downloads).toHaveLength(downloads);
  });

  it("does nothing more for the deregistration Garmin echoes", async () => {
    const { sub, userId } = await connected();
    await w.disconnect(sub, userId);
    await w.cron();
    const deletes = declaredDeletes().length;
    await w.notify("deregistrations", w.garmin.deregistration(kari));
    await w.cron();
    expect(declaredDeletes()).toHaveLength(deletes);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
  });

  it("leaves the user, so the same Garmin account comes back as the same person", async () => {
    const { sub, userId } = await connected();
    await w.disconnect(sub, userId);
    await w.cron();
    const again = await w.signIn(client, kari);
    await w.settled();
    expect(again.sub).toBe(sub);
    expect(w.sweatstack.connections.get(sub)?.userId).toBe(userId);
  });

  /** Contract: "If you have no connection for that `sub`, answer `2xx`." */
  it("answers 2xx for a connection it doesn't have, and asks Garmin nothing", async () => {
    const { sub, userId } = await connected();
    await w.disconnect(sub, userId);
    expect((await w.disconnect(sub, userId)).status).toBe(204);
    expect((await w.disconnect("nobody-we-know", userId)).status).toBe(204);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
  });

  it("answers 2xx for a connection SweatStack holds no subject for: there's nothing here to end", async () => {
    const { sub, userId } = await connected();
    expect((await w.disconnect(null, userId)).status).toBe(204);
    expect(w.garmin.deregistered).toEqual([]);
    // Still connected.
    expect((await w.disconnect(sub, userId)).status).toBe(204);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
  });

  it("leaves a connection that has since become another user's: a late retry for a deleted user", async () => {
    const { sub } = await connected();
    expect((await w.disconnect(sub, "the-deleted-user")).status).toBe(204);
    expect(w.garmin.deregistered).toEqual([]);
  });

  it("ends a connection still waiting for its user", async () => {
    const starter = w.sweatstack.createUser({});
    const { sub } = await w.signIn(client, kari, { startedBy: starter.id });
    await w.settled();
    expect((await w.disconnect(sub, starter.id)).status).toBe(204);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
  });

  /** Contract: "If your integration answers anything else, the connection stays and the Portal asks the user to try again." */
  it.each([500, 503, 429])("answers 503 and keeps the connection when Garmin answers %i, and the retry works", async (status) => {
    const { sub, userId } = await connected();
    w.garmin.failures.registration.push(status);
    expect((await w.disconnect(sub, userId)).status).toBe(503);
    expect(w.garmin.deregistered).toEqual([]);

    expect((await w.disconnect(sub, userId)).status).toBe(204);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
  });

  it("forgets the connection when Garmin says the token's already gone", async () => {
    const { sub, userId } = await connected();
    w.garmin.failures.registration.push(403);
    expect((await w.disconnect(sub, userId)).status).toBe(204);
    expect((await w.disconnect(sub, userId)).status).toBe(204);
    expect(w.garmin.deregistered).toEqual([]);
  });

  it("forgets the connection when Garmin has already revoked the grant", async () => {
    const { sub, userId } = await connected();
    w.garmin.revokeEverything();
    expect((await w.disconnect(sub, userId)).status).toBe(204);
    await w.ping(w.garmin.fileReady(kari, "1"));
    expect(w.garmin.downloads).toEqual([]);
  });
});

/** Contract: what the receiver of the Security Event Token must check. */
describe("a request the bridge refuses", () => {
  const refused = async (tamper: Parameters<typeof w.disconnect>[2]) => {
    const { sub, userId } = await connected();
    const response = await w.disconnect(sub, userId, tamper);
    expect(response.status).toBe(400);
    expect(w.garmin.deregistered).toEqual([]);
  };

  it("has another typ: it could be an ID token", () => refused({ typ: "JWT" }));
  it("is signed with another key", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    await refused({ key: privateKey });
  });
  it("comes from another issuer", () => refused({ iss: "https://elsewhere.test" }));
  it("is for another audience", () => refused({ aud: "https://elsewhere.test/oidc/garmin_connect" }));
  it("is more than five minutes old", () => refused({ iat: w.clock.now - FIVE_MINUTES - 1 }));
  it("comes from more than five minutes ahead", () => refused({ iat: w.clock.now + FIVE_MINUTES + 1 }));
  it("has no jti", () => refused({ jti: null }));
  it("names another issuer's subject", () => refused({ subjectIssuer: "https://elsewhere.test/oidc/garmin_connect" }));
  it.each([
    ["in another format", { format: "email", iss: ISSUER, sub: "someone" }],
    ["without an id", { format: "iss_sub", iss: ISSUER }],
  ])("names its subject %s", (_name, subject) =>
    refused({ events: { "https://sweatstack.no/events/connection-disconnect": { provider: "garmin_connect", subject } } }));
  it("is another kind of event", () => refused({ events: { "https://sweatstack.no/events/something-else": { provider: "garmin_connect" } } }));
  it("names another platform", () =>
    refused({ events: { "https://sweatstack.no/events/connection-disconnect": { provider: "another_platform" } } }));

  it("isn't a token at all", async () => {
    const { sub } = await connected();
    const response = await w.request("/oidc/garmin_connect/disconnect", { method: "POST", body: sub });
    expect(response.status).toBe(400);
    expect(w.garmin.deregistered).toEqual([]);
  });

  it("takes one at the edge of its five minutes", async () => {
    const { sub, userId } = await connected();
    expect((await w.disconnect(sub, userId, { iat: w.clock.now - FIVE_MINUTES })).status).toBe(204);
  });

  /** Contract: "`jti` and `iat`: refuse a `jti` you have seen." */
  it("has a jti already seen, so a copy can't end a connection made since", async () => {
    const { sub, userId } = await connected();
    expect((await w.disconnect(sub, userId, { jti: "the-one" })).status).toBe(204);
    await w.signIn(client, kari);
    await w.settled();

    expect((await w.disconnect(sub, userId, { jti: "the-one" })).status).toBe(400);
    expect(w.garmin.deregistered).toEqual([kari.userId]);
    expect(w.sweatstack.connections.get(sub)?.userId).toBe(userId);
  });
});
