#!/usr/bin/env node
// Walks you through Garmin's partner verification, one step at a time, and checks that each step's data
// reached the bridge. Stop with q at any step: running it again carries on there. RUNBOOK.md, "Pass Garmin's
// verification", has the same steps. `--origin https://...` overrides the address found through Cloudflare.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { unstable_readConfig } from "wrangler";
import { CloudflareProblem, findOrigin } from "./lib/cloudflare.mjs";
import { offersWellness } from "./lib/urls.mjs";
import { guide, STATE_FILE } from "./lib/verify-guide.mjs";
import { walk } from "./lib/walk.mjs";
import { wrangler } from "./lib/wrangler.mjs";

const WALK_FILE = "verification-walk.fit";

function stop(message) {
  console.error(message);
  process.exit(1);
}

/** A link that leads nowhere is answered 400 by a bridge that's ready, and 503 by one whose settings aren't complete. */
async function checkReady(origin) {
  const response = await fetch(`${origin}/start/garmin_connect/none`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (response === null) stop(`The bridge doesn't answer at ${origin}. Is it deployed, at this address?`);
  if (response.status === 503) stop("The bridge's settings aren't complete. Run npm run status to see which.");
  if (response.status !== 400) stop(`The address ${origin} answers ${response.status}, so the bridge isn't there. Is it deployed?`);
}

/** The bridge's database through the owner's Cloudflare login. A failure is null, and the guide tries again. */
function d1(sql) {
  // Wrangler gets no keyboard, so what the owner types reaches the guide.
  const result = wrangler(["d1", "execute", "DB", "--remote", "--yes", "--json", "--command", sql], { capture: true, check: false, stdin: "ignore" });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout)[0].results;
  } catch {
    return null;
  }
}

/** Lines typed, one at a time. Once the input ends, every question is answered "q". */
function terminal() {
  const lines = [];
  let waiting = null;
  let ended = false;
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => (waiting ? waiting(line) : lines.push(line)));
  input.on("close", () => {
    ended = true;
    waiting?.("q");
  });
  const next = (ms) =>
    new Promise((answer) => {
      if (lines.length > 0) return answer(lines.shift());
      if (ended) return answer("q");
      const timer = ms === undefined ? undefined : setTimeout(() => ((waiting = null), answer(null)), ms);
      waiting = (line) => {
        clearTimeout(timer);
        waiting = null;
        answer(line);
      };
    });
  return {
    print: (text) => console.log(text),
    ask: (question) => (console.log(question), next()),
    idle: (ms) => next(ms),
    close: () => input.close(),
  };
}

const config = unstable_readConfig({ config: "wrangler.jsonc" });
const origin = await findOrigin(config).catch((error) => {
  if (!(error instanceof CloudflareProblem)) throw error;
  stop(error.message);
});
await checkReady(origin);

const io = terminal();
await guide(io, {
  name: config.name,
  origin,
  wellness: offersWellness(config.vars?.GARMIN_APP_OFFERS),
  now: () => Math.floor(Date.now() / 1000),
  query: async (sql) => d1(sql),
  execute: async (sql) => d1(sql) !== null,
  writeWalk: async () => {
    const file = resolve(WALK_FILE);
    writeFileSync(file, walk(new Date()));
    return file;
  },
  loadState: () => {
    try {
      return JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      return null;
    }
  },
  saveState: (state) => (state === null ? rmSync(STATE_FILE, { force: true }) : writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)),
});
io.close();
