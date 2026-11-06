import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, resetDatabase, world, type Client } from "../support/world";

const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };
const MINUTE = 60;

/** Contract: "Move an existing SweatStack account". */
describe("moving an existing SweatStack account", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  const userOf = (subject: string) => w.sweatstack.connections.get(subject)?.userId;
  const aMinuteLater = async () => {
    w.clock.now += MINUTE;
    await w.cron();
  };

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world();
    client = await w.register();
  });

  it("names the platform's account on the call after consent, together with the state", async () => {
    const { state } = await w.signIn(client, kari);
    expect(w.sweatstack.connectionCalls[0]).toMatchObject({ state, platformUserId: "garmin-kari" });
  });

  /** Contract: "`state`: Send it on the call you make after the platform's consent. Leave it out on later calls." */
  it("sends neither on later calls", async () => {
    w.sweatstack.offerMove("garmin-kari");
    await w.signIn(client, kari);
    await w.settled();
    await aMinuteLater();
    const later = w.sweatstack.connectionCalls.slice(1);
    expect(later.length).toBeGreaterThan(0);
    for (const call of later) {
      expect(call).not.toHaveProperty("state");
      expect(call).not.toHaveProperty("platformUserId");
    }
  });

  it("sends neither when reconnecting: the user is known", async () => {
    const first = await w.signIn(client, kari);
    const known = userOf(first.sub);
    const before = w.sweatstack.connectionCalls.length;
    await w.signIn(client, kari, { startedBy: known });
    await w.settled();
    for (const call of w.sweatstack.connectionCalls.slice(before)) {
      expect(call).not.toHaveProperty("platformUserId");
    }
  });

  describe("while the question is open", () => {
    it("makes no user, however often it asks", async () => {
      w.sweatstack.offerMove("garmin-kari");
      const usersBefore = w.sweatstack.users.size;
      const { sub } = await w.signIn(client, kari);
      await w.settled();
      await aMinuteLater();
      await aMinuteLater();
      expect(userOf(sub)).toBeNull();
      expect(w.sweatstack.users.size).toBe(usersBefore);
    });

    it("holds the files", async () => {
      w.sweatstack.offerMove("garmin-kari");
      await w.signIn(client, kari);
      await w.ping(w.garmin.fileReady(kari, "1001"));
      await aMinuteLater();
      expect(w.sweatstack.uploads).toEqual([]);
    });
  });

  it("uploads to the old account once it has moved", async () => {
    const account = w.sweatstack.offerMove("garmin-kari");
    const { sub } = await w.signIn(client, kari);
    await w.ping(w.garmin.fileReady(kari, "1001"));

    w.sweatstack.accountMoved(sub, account.id);
    await aMinuteLater();

    expect(userOf(sub)).toBe(account.id);
    expect(w.sweatstack.uploads.map((upload) => [upload.userId, upload.externalId])).toEqual([[account.id, "1001"]]);
  });

  it("uploads to a new user when the athlete starts fresh", async () => {
    const account = w.sweatstack.offerMove("garmin-kari");
    const { sub, state } = await w.signIn(client, kari);
    await w.ping(w.garmin.fileReady(kari, "1001"));

    w.sweatstack.browserReturns(state, sub, { session: null });
    await aMinuteLater();

    const fresh = userOf(sub);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(account.id);
    expect(w.sweatstack.uploads.map((upload) => upload.userId)).toEqual([fresh]);
  });

  it("doesn't fail a sign-in when SweatStack is down: the athlete just isn't asked", async () => {
    let refused = false;
    w = world({
      intercept: (request) => {
        if (request.method !== "PUT" || !request.url.includes("/connections/") || refused) return undefined;
        refused = true;
        return new Response(null, { status: 503 });
      },
    });
    client = await w.register();
    w.sweatstack.offerMove("garmin-kari");
    const { sub } = await w.signIn(client, kari);
    await w.settled();
    expect(userOf(sub)).toEqual(expect.any(String));
  });
});
