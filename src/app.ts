import { Hono } from "hono";
import { readConfig, type Env } from "./config";
import { log } from "./log";
import { findProvider } from "./providers";

/** Everything the bridge takes from the outside world, so tests can replace all of it. */
export interface Deps {
  env: Env;
  fetch: typeof fetch;
  /** The current time in seconds since the epoch. */
  now: () => number;
}

const README_URL = "https://github.com/SweatStack/sweatstack-bridge";

export function createApp(deps: Deps): Hono {
  const app = new Hono();

  app.get("/", (c) => c.text(`A SweatStack bridge. See ${README_URL}\n`));

  // A public route never says which setting is missing. `npm run status` tells the owner.
  app.all("/oidc/:provider/*", async (c, next) => {
    const provider = findProvider(c.req.param("provider"));
    if (!provider) return c.notFound();
    if (!readConfig(deps.env, provider).ok) {
      return c.json({ error: "temporarily_unavailable" }, 503);
    }
    await next();
  });

  // Logs the error's name only: a message can carry a URL or a token.
  app.onError((error, c) => {
    log("request_failed", { error: error.name });
    return c.json({ error: "server_error" }, 500);
  });

  return app;
}
