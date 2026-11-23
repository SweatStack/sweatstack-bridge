import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Database } from "../../src/db";
import { ALL_PERMISSIONS, PROVIDER, resetDatabase, world, type Client } from "../support/world";

const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };
const db = new Database(env.DB);

/** Everything under `seen:` in `meta`, as the console reads it. */
const seen = async () => Object.fromEntries(await db.seen());

describe("what the bridge has seen, for the console (plan 006, C5)", () => {
  let w: ReturnType<typeof world>;
  let client: Client;

  beforeEach(async () => {
    await resetDatabase({ withSigningKey: true });
    w = world({ settings: { GARMIN_APP_OFFERS: "activities" } });
    client = await w.register();
  });

  it("has seen nothing on a fresh bridge", async () => {
    expect(await seen()).toEqual({});
  });

  it("records when a platform sign-in last completed", async () => {
    await w.signIn(client, kari);
    await w.settled();
    expect(await seen()).toEqual({ [`seen:consent:${PROVIDER}`]: w.clock.now });

    w.clock.now += 60;
    await w.signIn(client, kari);
    await w.settled();
    expect(await seen()).toEqual({ [`seen:consent:${PROVIDER}`]: w.clock.now });
  });

  it("doesn't record a sign-in that the platform refused", async () => {
    const response = await w.request(`/callback/${PROVIDER}?state=nobody&code=x`);
    expect(response.status).toBe(400);
    expect(await seen()).toEqual({});
  });

  it("records when each kind of push was last accepted, by the name of its URL", async () => {
    await w.signIn(client, kari);
    await w.settled();
    w.clock.now += 10;
    await w.ping(w.garmin.fileReady(kari, "1001"));
    w.clock.now += 10;
    await w.notify("user-permissions", { userPermissionsChange: [] });

    expect(await seen()).toEqual({
      [`seen:consent:${PROVIDER}`]: w.clock.now - 20,
      [`seen:push:${PROVIDER}:activity-files`]: w.clock.now - 10,
      [`seen:push:${PROVIDER}:user-permissions`]: w.clock.now,
    });
  });

  it("counts a push that carries nothing the bridge uses: Garmin sent it, so the URL works", async () => {
    await w.notify("deregistrations", { deregistrations: [] });
    expect(await seen()).toEqual({ [`seen:push:${PROVIDER}:deregistrations`]: w.clock.now });
  });

  describe("when the record can't be written", () => {
    afterEach(() => vi.restoreAllMocks());

    const failingWrites = () => {
      const setMeta = Database.prototype.setMeta;
      vi.spyOn(Database.prototype, "setMeta").mockImplementation(function (this: Database, key: string, value: string) {
        return key.startsWith("seen:") ? Promise.reject(new Error("D1_ERROR")) : setMeta.call(this, key, value);
      });
      return vi.spyOn(console, "warn").mockImplementation(() => {});
    };

    it("still completes the sign-in, and says so in the logs", async () => {
      const warned = failingWrites();
      const { claims } = await w.signIn(client, kari);
      expect(claims.sub).toEqual(expect.any(String));
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('"event":"seen_not_recorded"'));
      expect(await seen()).toEqual({});
    });

    it("still accepts the push", async () => {
      failingWrites();
      const response = await w.notify("deregistrations", { deregistrations: [] });
      expect(response.status).toBe(200);
    });
  });

  it.each([
    ["a wrong secret", () => w.webhook("activity-files", { activityFiles: [] }, { secret: "0".repeat(64) })],
    ["a kind it doesn't take", () => w.webhook("no-such-kind", {})],
    ["a body that isn't JSON", () => w.webhook("activity-files", "{")],
  ])("writes nothing for a refused push: %s", async (_, refused) => {
    const response = await refused();
    expect(response.ok).toBe(false);
    expect(await seen()).toEqual({});
  });
});
