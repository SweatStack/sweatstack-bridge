import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ISSUER, ORIGIN, pathOf, resetDatabase, world } from "../support/world";

/** Every value the console gives the owner to paste, read from the signed-in page, as the owner reads it. */
async function pasted(offers?: { wellness: boolean }) {
  const w = world({ settings: { GARMIN_APP_OFFERS: offers?.wellness ? "activities,activity_history,wellness" : "activities,activity_history" } });
  const signIn = await w.request("/console/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ secret: w.sweatstack.clientSecret }).toString(),
  });
  const cookie = (signIn.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
  const html = await (await w.request("/console", { headers: { Cookie: cookie } })).text();
  const urls = [...html.matchAll(/<input readonly(?:="")? value="([^"]+)" aria-label="([^"]+)"/g)].map(([, url, setting]) => ({
    setting: setting as string,
    url: url as string,
    check: / - /.test(setting as string) ? "webhook" : undefined,
  }));
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

  it.each([
    [false, ["ACTIVITY - Activity Files", "COMMON - Deregistrations", "COMMON - User Permissions Change"]],
    [
      true,
      [
        "ACTIVITY - Activity Files",
        "COMMON - Deregistrations",
        "COMMON - User Permissions Change",
        "HEALTH - Body Compositions",
        "HEALTH - Dailies",
        "HEALTH - HRV Summary",
        "HEALTH - Sleeps",
      ],
    ],
  ])("names Garmin's settings as its endpoint configuration does, in its order (wellness: %s)", async (wellness, settings) => {
    const { urls } = await pasted({ wellness });
    expect(urls.filter((entry) => entry.check === "webhook").map((entry) => entry.setting)).toEqual(settings);
  });

  it.each([
    ["an app without wellness", false, 3],
    ["an app with wellness", true, 7],
  ])("names webhooks the bridge takes, for %s, and an empty ping changes nothing", async (_name, wellness, expected) => {
    const { urls } = await pasted({ wellness });
    const webhooks = urls.filter((entry) => entry.check === "webhook");
    expect(webhooks).toHaveLength(expected);
    const w = world({ settings: { GARMIN_APP_OFFERS: wellness ? "activities,activity_history,wellness" : "activities,activity_history" } });
    for (const { url } of webhooks) {
      const response = await w.request(pathOf(url), { method: "POST", body: "{}" });
      expect(response.status, url).toBe(200);
    }
    await w.settled();
    const { count } = (await env.DB.prepare("SELECT COUNT(*) AS count FROM inbox").first<{ count: number }>())!;
    expect(count).toBe(0);
  });
});
