/// <reference types="vite/client" />
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, ORIGIN, resetDatabase, world, type WorldOptions } from "../support/world";

/** The signed-in page, from a real bridge between the fakes: what the owner sees at each point of setup. */

const kari = { userId: "garmin-kari", permissions: ALL_PERMISSIONS };

let w: ReturnType<typeof world>;
let cookie: string;

/** The page as text, entities decoded, so the assertions read like the page. */
const page = async () => (await (await w.request("/console", { headers: { Cookie: cookie } })).text()).replaceAll("&#39;", "'").replaceAll("&amp;", "&");

const setUp = async (options: WorldOptions = {}) => {
  w = world(options);
  const response = await w.request("/console/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams({ secret: w.sweatstack.clientSecret }).toString(),
  });
  cookie = (response.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
};

const webhookSecret = async () => (await env.DB.prepare("SELECT value FROM meta WHERE key = 'webhook_secret'").first<{ value: string }>())?.value as string;

beforeEach(async () => {
  await resetDatabase({ withSigningKey: true });
  await env.DB.prepare("DELETE FROM meta WHERE key = 'latest_release'").run();
});

describe("the console, just deployed", () => {
  beforeEach(() => setUp());

  it("says three steps are left, with every value to paste", async () => {
    const html = await page();
    expect(html).toContain("<span>Three steps left.</span>");
    expect(html).toContain(`value="${ORIGIN}/callback/garmin_connect"`);
    expect(html).toContain(`value="${ORIGIN}/oidc/garmin_connect"`);
    const secret = await webhookSecret();
    for (const webhook of ["activity-files", "deregistrations", "user-permissions"]) {
      expect(html).toContain(`value="${ORIGIN}/garmin_connect/${secret}/${webhook}"`);
    }
    expect(html).not.toContain("/dailies");
  });

  it("links straight to the app's Data sources tab in SweatStack", async () => {
    expect(await page()).toContain(`href="${w.sweatstack.url}/applications/${w.sweatstack.appId}/data-sources"`);
  });

  it("shows neither client secret", async () => {
    const html = await page();
    expect(html).not.toContain(w.sweatstack.clientSecret);
    expect(html).not.toContain(w.garmin.clientSecret);
  });

  it("opens every step, and folds none", async () => {
    const html = await page();
    expect(html.match(/data-state="open"/g)).toHaveLength(4);
    expect(html).not.toContain('data-state="proven"');
  });

  it("works without JavaScript: copy buttons wait for the script, and every value is in a field", async () => {
    const html = await page();
    expect(html).toMatch(/<button type="button" data-copy(="true")? hidden/);
    expect(html).toContain("<input readonly");
  });

  it("runs no inline script and no inline style", async () => {
    const html = await page();
    expect(html).not.toMatch(/<script>|<script(?![^>]*\bsrc=)[^>]*>|<style|\sstyle=|\son[a-z]+=/i);
  });
});

describe("the console, as setup goes on", () => {
  beforeEach(() => setUp());

  it("folds each step as the bridge sees it work, then puts the status first", async () => {
    const client = await w.register();
    expect(await page()).toContain("<span>Two steps left.</span>");

    await w.signIn(client, kari);
    await w.settled();
    expect(await page()).toContain("<span>One step left.</span>");

    w.clock.now += 120;
    await w.ping(w.garmin.fileReady(kari, "1001"));
    const html = await page();
    expect(html).toContain("<span>Your bridge is working.</span>");
    expect(html).toContain("Garmin last sent a notification");
    expect(html.indexOf("Athletes connected")).toBeLessThan(html.indexOf("Every step is done"));
  });

  it("says when each notification setting last sent", async () => {
    w.clock.now += 0;
    await w.notify("deregistrations", { deregistrations: [] });
    w.clock.now += 18 * 60;
    expect(await page()).toMatch(/COMMON - Deregistrations<\/span><span class="seen ok">.*Last sent <time[^>]*>18 minutes ago<\/time>/s);
  });
});

describe("the console's banners", () => {
  it("names a missing setting, and links to the Worker in Cloudflare", async () => {
    await setUp({ settings: { GARMIN_CLIENT_SECRET: "" } });
    const html = await page();
    expect(html).toContain("Some settings need you");
    expect(html).toContain("<li>GARMIN_CLIENT_SECRET is not set</li>");
    expect(html).toContain('href="https://dash.cloudflare.com/?to=/:account/workers-and-pages"');
  });

  it("says SweatStack refuses the credentials", async () => {
    await setUp();
    w = world({ settings: { SWEATSTACK_CLIENT_ID: "another-app" } });
    expect(await page()).toContain("SweatStack doesn't accept this bridge's Client ID and secret");
  });

  it("offers a newer release", async () => {
    await setUp({ elsewhere: (request) => (request.url.includes("api.github.com") ? Response.json({ tag_name: "v99.0.0" }) : undefined) });
    const html = await page();
    expect(html).toContain("<b>v99.0.0 is available</b>");
    expect(html).toContain('href="https://github.com/SweatStack/sweatstack-bridge/releases/tag/v99.0.0"');
  });
});

describe("an app that offers wellness", () => {
  beforeEach(() => setUp({ settings: { GARMIN_APP_OFFERS: "activities,activity_history,wellness" } }));

  it("lists the health settings too, with when it's normal to have heard nothing", async () => {
    const html = await page();
    expect(html).toContain("Enable these seven settings");
    expect(html).toContain("Nothing yet, which is normal until an athlete records a weight");
    expect(html).toContain("Last daily values");
  });
});

describe("the console's static files", () => {
  const files = Object.keys(import.meta.glob("/public/**/*", { query: "?raw", eager: true }));

  it("live only under /console/, so none can stand in for a route SweatStack or the platform calls", () => {
    expect(files.sort()).toEqual(["/public/console/console.css", "/public/console/console.js", "/public/console/icon.svg"]);
  });
});
