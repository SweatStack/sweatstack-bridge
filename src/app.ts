import { Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { readConfig } from "./config";
import { consoleRoutes } from "./console";
import type { PlatformVariables } from "./context";
import { Database } from "./db";
import type { Deps } from "./deps";
import { disconnect } from "./flows/disconnect";
import { platformCallback } from "./flows/platform-callback";
import { start } from "./flows/start";
import { webhook } from "./flows/webhook";
import { log } from "./log";
import { authorize } from "./oidc/authorize";
import { discovery } from "./oidc/discovery";
import { jwks } from "./oidc/keys";
import { register } from "./oidc/register";
import { token } from "./oidc/token";
import { findProvider } from "./providers";

const README_URL = "https://github.com/SweatStack/sweatstack-bridge";

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.get("/", (c) => c.text(`A SweatStack bridge. Its owner signs in at /console. See ${README_URL}\n`));

  // Before the platform routes, whose webhook route would otherwise match a console path.
  app.route("/console", consoleRoutes(deps));

  const platform = new Hono<{ Variables: PlatformVariables }>();
  platform.use(servesPlatform(deps));
  platform.get("/oidc/:provider/.well-known/openid-configuration", discovery);
  platform.get("/oidc/:provider/authorize", authorize);
  platform.post("/oidc/:provider/token", token);
  platform.get("/oidc/:provider/jwks", jwks);
  platform.post("/oidc/:provider/register", register);
  platform.post("/oidc/:provider/disconnect", disconnect);
  platform.get("/start/:provider/:flow", start);
  platform.get("/callback/:provider", platformCallback);
  platform.post("/:provider/:secret/:kind", webhook);

  app.route("/", platform);

  // A message can carry a URL or a token, so it's logged only from the database, which reports the
  // statement and never the values bound to it.
  app.onError((error, c) => {
    // An answer a middleware chose, such as the console's CSRF check refusing a request.
    if (error instanceof HTTPException) return error.getResponse();
    log("request_failed", {
      error: error.name,
      route: c.req.routePath,
      detail: error.message.startsWith("D1_") ? error.message : null,
    });
    return c.json({ error: "server_error" }, 500);
  });

  return app;
}

/**
 * Answers for a platform that doesn't exist or isn't set up yet, and gives the routes what they need. A
 * public route never says which setting is missing: the console tells the owner.
 */
function servesPlatform(deps: Deps): MiddlewareHandler<{ Variables: PlatformVariables }> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const [, first, second] = url.pathname.split("/");
    const isWebhook = first !== "oidc" && first !== "start" && first !== "callback";
    const name = isWebhook ? first : second;

    const provider = name === undefined ? undefined : findProvider(name, deps);
    if (provider === undefined) return c.notFound();

    const result = readConfig(deps.env, provider);
    if (!result.ok) return isWebhook ? c.notFound() : c.json({ error: "temporarily_unavailable" }, 503);

    c.set("deps", deps);
    c.set("db", new Database(deps.env.DB));
    c.set("config", result.config);
    c.set("provider", provider);
    c.set("issuer", `${url.origin}/oidc/${provider.name}`);
    c.set("callbackUrl", `${url.origin}/callback/${provider.name}`);
    await next();
  };
}
