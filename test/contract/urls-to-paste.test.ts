import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { urlsToPaste } from "../../scripts/lib/urls.mjs";
import { ISSUER, ORIGIN, pathOf, resetDatabase, world } from "../support/world";

async function pasted() {
  const secret = await env.DB.prepare("SELECT value FROM meta WHERE key = 'webhook_secret'").first<string>("value");
  const urls = urlsToPaste(ORIGIN, secret).flatMap((place) => place.urls);
  const find = (setting: string) => urls.find((entry) => entry.setting === setting)?.url ?? "";
  return { urls, find };
}

describe("the URLs an owner pastes", () => {
  beforeEach(() => resetDatabase({ withSigningKey: true }));

  it("names the issuer the bridge says it has", async () => {
    const { find } = await pasted();
    const response = await world().request(`${pathOf(find("Issuer URL"))}/.well-known/openid-configuration`);
    expect(await response.json()).toMatchObject({ issuer: ISSUER });
  });

  it("names the redirect URL the bridge sends to Garmin", async () => {
    const { find } = await pasted();
    const w = world();
    const client = await w.register();
    const response = await w.authorize(client);
    const consent = new URL(response.headers.get("Location") ?? "");
    expect(consent.searchParams.get("redirect_uri")).toBe(find("OAuth 2 redirect URL"));
  });

  it("names webhooks the bridge takes, and an empty ping changes nothing", async () => {
    const { urls } = await pasted();
    const webhooks = urls.filter((entry) => entry.check === "webhook");
    expect(webhooks).toHaveLength(3);
    const w = world();
    for (const { url } of webhooks) {
      const response = await w.request(pathOf(url), { method: "POST", body: "{}" });
      expect(response.status, url).toBe(200);
    }
    await w.settled();
    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM inbox").first<{ count: number }>())!;
    expect(count).toBe(0);
  });
});
