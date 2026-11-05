import { createApp } from "./app";
import type { Env } from "./config";

export default {
  fetch(request, env, ctx) {
    const app = createApp({
      env,
      fetch: (input, init) => fetch(input, init),
      now: () => Math.floor(Date.now() / 1000),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      waitUntil: (work) => ctx.waitUntil(work),
    });
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
