import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ORIGIN, resetDatabase, world } from "../support/world";

/** Plan 006: C1 (signing in with the client secret), C2 (the session), C9 (headers and CSRF), C12 (logs). */

const SESSION_SECONDS = 12 * 60 * 60;
const SIGNED_IN = 'data-page="console"';

const CSP =
  "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

let w: ReturnType<typeof world>;

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
  body: new URLSearchParams(fields).toString(),
});

const signIn = (secret: string) => w.request("/console/sign-in", form({ username: "owner", secret }));

/** The cookie a response sets, as the browser would send it back. */
const cookieFrom = (response: Response) => (response.headers.get("Set-Cookie") ?? "").split(";")[0] as string;

const page = (cookie?: string) => w.request("/console", cookie ? { headers: { Cookie: cookie } } : undefined);

const secret = () => w.sweatstack.clientSecret;

beforeEach(async () => {
  await resetDatabase({ withSigningKey: true });
  w = world();
});

afterEach(() => vi.restoreAllMocks());

describe("signing in to the console", () => {
  it("asks for the client secret, and shows nothing about the bridge", async () => {
    const response = await page();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('type="password"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).not.toContain(SIGNED_IN);
    for (const detail of [w.sweatstack.appId, w.garmin.clientId, "garmin_connect", "/oidc/", "/callback/"]) {
      expect(html).not.toContain(detail);
    }
  });

  it("signs in with the bridge's client secret, for 12 hours", async () => {
    const response = await signIn(secret());
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/console");
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toMatch(/^console=\d+\.[\w-]+;/);
    for (const attribute of ["Path=/console", `Max-Age=${SESSION_SECONDS}`, "HttpOnly", "Secure", "SameSite=Lax"]) {
      expect(setCookie).toContain(attribute);
    }
    expect(await (await page(cookieFrom(response))).text()).toContain(SIGNED_IN);
  });

  it("never puts the secret in the cookie", async () => {
    const response = await signIn(secret());
    expect(response.headers.get("Set-Cookie")).not.toContain(secret());
  });

  it.each([
    ["a wrong secret", () => `${secret()}x`],
    ["an empty secret", () => ""],
    ["the Garmin secret", () => w.garmin.clientSecret],
  ])("refuses %s, and says so", async (_, attempt) => {
    const response = await signIn(attempt());
    expect(response.status).toBe(401);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const html = (await response.text()).replaceAll("&#39;", "'");
    expect(html).toContain("That isn't this bridge's secret.");
    expect(html).not.toContain(SIGNED_IN);
  });

  it("logs each try, with no value", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    await signIn(`${secret()}x`);
    await signIn(secret());
    const events = logged.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(events).toEqual([
      { event: "console_sign_in", ok: false },
      { event: "console_sign_in", ok: true },
    ]);
  });
});

describe("a bridge with no client secret yet", () => {
  beforeEach(() => {
    w = world({ settings: { SWEATSTACK_CLIENT_SECRET: "" } });
  });

  it("says which setting to add, and has no form", async () => {
    const html = await (await page()).text();
    expect(html).toContain("SWEATSTACK_CLIENT_SECRET");
    expect(html).not.toContain('type="password"');
  });

  it.each([[""], ["anything"]])("lets no secret in: %j", async (attempt) => {
    const response = await signIn(attempt);
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(await (await page(cookieFrom(response))).text()).not.toContain(SIGNED_IN);
  });
});

describe("the session", () => {
  let cookie: string;

  beforeEach(async () => {
    cookie = cookieFrom(await signIn(secret()));
  });

  it("lasts 12 hours, and not a second more", async () => {
    w.clock.now += SESSION_SECONDS - 1;
    expect(await (await page(cookie)).text()).toContain(SIGNED_IN);
    w.clock.now += 1;
    expect(await (await page(cookie)).text()).not.toContain(SIGNED_IN);
  });

  it("can't be stretched by changing its expiry", async () => {
    const [name, value] = cookie.split("=") as [string, string];
    const [expiry, mac] = value.split(".") as [string, string];
    const stretched = `${name}=${Number(expiry) + SESSION_SECONDS}.${mac}`;
    w.clock.now += SESSION_SECONDS;
    expect(await (await page(stretched)).text()).not.toContain(SIGNED_IN);
  });

  it.each([
    ["a forged one", () => `console=${w.clock.now + 60}.forged`],
    ["one with no MAC", () => `console=${w.clock.now + 60}`],
    ["garbage", () => "console=..."],
  ])("refuses %s", async (_, forged) => {
    expect(await (await page(forged())).text()).not.toContain(SIGNED_IN);
  });

  it("ends when the client secret is rotated", async () => {
    w = world({ settings: { SWEATSTACK_CLIENT_SECRET: "a-rotated-secret" } });
    expect(await (await page(cookie)).text()).not.toContain(SIGNED_IN);
  });

  it("ends at sign out", async () => {
    const response = await w.request("/console/sign-out", { ...form({}), headers: { ...form({}).headers, Cookie: cookie } });
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/console");
    expect(response.headers.get("Set-Cookie")).toMatch(/^console=;.*Max-Age=0/);
  });
});

describe("every console answer", () => {
  const answers = async () => {
    const signedIn = cookieFrom(await signIn(secret()));
    return [
      await page(),
      await page(signedIn),
      await signIn("wrong"),
      await signIn(secret()),
      await w.request("/console/sign-out", form({})),
      await w.request("/console/no-such-page"),
    ];
  };

  it("carries the console's headers", async () => {
    for (const response of await answers()) {
      expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("leaves the routes SweatStack and Garmin call alone", async () => {
    const discovery = await w.request(w.discoveryPath);
    expect(discovery.headers.get("Content-Security-Policy")).toBeNull();
  });
});

describe("a POST from another site", () => {
  it.each([
    ["no Origin", undefined],
    ["another origin", "https://attacker.test"],
  ])("is refused, with %s", async (_, origin) => {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
    if (origin !== undefined) headers.Origin = origin;
    for (const path of ["/console/sign-in", "/console/sign-out"]) {
      const response = await w.request(path, { method: "POST", headers, body: new URLSearchParams({ secret: secret() }).toString() });
      expect(response.status).toBe(403);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
  });
});
