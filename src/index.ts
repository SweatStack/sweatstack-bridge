import { createApp } from "./app";
import type { Env } from "./config";
import type { Deps } from "./deps";
import { sweep } from "./inbox/sweeper";

function deps(env: Env, ctx: ExecutionContext): Deps {
  return {
    env,
    fetch: (input, init) => fetch(input, init),
    now: () => Math.floor(Date.now() / 1000),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    waitUntil: (work) => ctx.waitUntil(work),
  };
}

export default {
  fetch(request, env, ctx) {
    return createApp(deps(env, ctx)).fetch(request, env, ctx);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(sweep(deps(env, ctx)));
  },
} satisfies ExportedHandler<Env>;
