import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { setting } from "../config";
import type { Deps } from "../deps";
import { log } from "../log";
import { isClientSecret, isSession, newSession, SESSION_COOKIE, SESSION_SECONDS } from "./session";
import { ConsolePage, NoSecretPage, SignInPage } from "./views";

/**
 * The console, at `/console` (plan 006). It works with any configuration, including none, so it reads each
 * setting on its own and never goes through the platform routes' checks.
 */

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self'",
  "script-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/** On every console answer, whatever it is (C9). The pages hold the webhook URLs, which hold a secret. */
const consoleHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
};

const COOKIE_OPTIONS = { path: "/console", httpOnly: true, secure: true, sameSite: "Lax" } as const;

export function consoleRoutes(deps: Deps): Hono {
  const app = new Hono();
  app.use(consoleHeaders);
  app.use(csrf());

  const clientSecret = () => setting(deps.env, "SWEATSTACK_CLIENT_SECRET");
  const host = (url: string) => new URL(url).host;

  app.get("/", async (c) => {
    const secret = clientSecret();
    if (secret === undefined) return c.html(NoSecretPage({ host: host(c.req.url) }));
    if (!(await isSession(getCookie(c, SESSION_COOKIE), secret, deps.now()))) {
      return c.html(SignInPage({ host: host(c.req.url), failed: false }));
    }
    return c.html(ConsolePage({ host: host(c.req.url) }));
  });

  app.post("/sign-in", async (c) => {
    const secret = clientSecret();
    if (secret === undefined) return c.redirect("/console", 303);
    const form = await c.req.parseBody();
    const attempt = typeof form.secret === "string" ? form.secret : "";
    const ok = await isClientSecret(attempt, secret);
    log("console_sign_in", { ok });
    if (!ok) return c.html(SignInPage({ host: host(c.req.url), failed: true }), 401);
    setCookie(c, SESSION_COOKIE, await newSession(secret, deps.now()), { ...COOKIE_OPTIONS, maxAge: SESSION_SECONDS });
    return c.redirect("/console", 303);
  });

  app.post("/sign-out", (c) => {
    deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
    log("console_sign_out");
    return c.redirect("/console", 303);
  });

  return app;
}
