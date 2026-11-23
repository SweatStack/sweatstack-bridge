import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { setting } from "../config";
import type { Deps } from "../deps";
import { Database } from "../db";
import { log } from "../log";
import { isClientSecret, isSession, newSession, SESSION_COOKIE, SESSION_SECONDS } from "./session";
import { consolePlatform, gatherFacts } from "./facts";
import type { VerificationStep } from "../providers/types";
import { advance, loadWalk, moveOn, newWalk, saveWalk, startSignIn, walkSteps } from "./verification";
import { ConsolePage, LandedPage, NoSecretPage, SignInPage, WalkPage } from "./views";

/**
 * The console, at `/console`. It works with any configuration, including none, so it reads each
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
  const origin = (c: Context) => new URL(c.req.url).origin;
  const signedIn = async (c: Context) => {
    const secret = clientSecret();
    return secret !== undefined && (await isSession(getCookie(c, SESSION_COOKIE), secret, deps.now()));
  };

  app.get("/", async (c) => {
    if (clientSecret() === undefined) return c.html(NoSecretPage({ origin: origin(c) }));
    if (!(await signedIn(c))) return c.html(SignInPage({ origin: origin(c), failed: false }));
    return c.html(ConsolePage({ facts: await gatherFacts(deps, origin(c)) }));
  });

  app.post("/sign-in", async (c) => {
    const secret = clientSecret();
    if (secret === undefined) return c.redirect("/console", 303);
    const form = await c.req.parseBody();
    const attempt = typeof form.secret === "string" ? form.secret : "";
    const ok = await isClientSecret(attempt, secret);
    log("console_sign_in", { ok });
    if (!ok) return c.html(SignInPage({ origin: origin(c), failed: true }), 401);
    setCookie(c, SESSION_COOKIE, await newSession(secret, deps.now()), { ...COOKIE_OPTIONS, maxAge: SESSION_SECONDS });
    return c.redirect("/console", 303);
  });

  app.post("/sign-out", (c) => {
    deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
    log("console_sign_out");
    return c.redirect("/console", 303);
  });

  // Where the private window lands after the platform's consent. It has no session there, so it says nothing.
  app.get("/verification/connected", (c) => c.html(LandedPage({ origin: origin(c), failed: c.req.query("error") !== undefined })));

  /** The walk, its steps for this app, and the bridge's database, for a signed-in owner. Null otherwise. */
  const walkContext = async (c: Context) => {
    const provider = consolePlatform(deps);
    const guide = provider.guide.verification;
    if (guide === undefined || !(await signedIn(c))) return null;
    const db = new Database(deps.env.DB);
    const steps = walkSteps(guide, provider.offeredCapabilities());
    return { db, provider, guide, steps, walk: await currentWalk(db, steps) };
  };

  /** The walk, moved on through whatever data has come since it was last looked at, and saved if it moved. */
  const currentWalk = async (db: Database, steps: readonly VerificationStep[]) => {
    const saved = await loadWalk(db);
    if (saved === null) return null;
    if (!steps.some((step) => step.id === saved.step) && saved.finishedAt === undefined) {
      // A step this app no longer takes, as after it stopped offering wellness: start again.
      await saveWalk(db, null);
      return null;
    }
    const progress = await db.walkProgress(Object.values(saved.accounts), saved.flow?.id ?? null);
    const walk = advance(saved, steps, progress, deps.now());
    if (JSON.stringify(walk) !== JSON.stringify(saved)) await saveWalk(db, walk);
    return walk;
  };

  app.get("/verification", async (c) => {
    const context = await walkContext(c);
    if (context === null) return c.redirect("/console", 302);
    const { provider, guide, steps, walk } = context;
    return c.html(WalkPage({ origin: origin(c), provider: provider.name, platform: provider.guide.name, guide, steps, walk, now: deps.now() }));
  });

  app.post("/verification", async (c) => {
    const context = await walkContext(c);
    if (context === null) return c.redirect("/console", 303);
    const { db, provider, steps, walk } = context;
    const form = await c.req.parseBody();
    const step = steps.find((candidate) => candidate.id === walk?.step);
    const now = deps.now();
    switch (form.action) {
      case "start":
        await saveWalk(db, newWalk(steps, now, typeof form.timeZone === "string" ? form.timeZone : "UTC"));
        break;
      case "link":
        if (walk !== null && step?.proof.kind === "connected") {
          const { id, expiresAt } = await startSignIn(db, provider.name, `${origin(c)}/console/verification/connected`, now);
          const { notice: _, ...rest } = walk;
          await saveWalk(db, { ...rest, flow: { id, expiresAt } });
        }
        break;
      case "skip":
        if (walk !== null && (step?.proof.kind === "job" || step?.proof.kind === "removed" || step?.proof.kind === "measured")) {
          await saveWalk(db, moveOn(walk, steps, now, "skipped"));
        }
        break;
      case "passed":
        if (walk !== null && step?.proof.kind === "tests") await saveWalk(db, moveOn(walk, steps, now));
        break;
      case "restart":
        await saveWalk(db, null);
        break;
    }
    return c.redirect("/console/verification", 303);
  });

  return app;
}
