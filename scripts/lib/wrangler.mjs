import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateSigningKey } from "./signing-key.mjs";

const NO_DATABASE_YET = /Couldn't find a D1 DB/;

// Wrangler's own entry point, run with this Node. Not through `npx`: on Windows that's npx.cmd,
// which Node can't start without a shell, and a shell would mangle arguments like SQL queries.
const packageJson = createRequire(import.meta.url).resolve("wrangler/package.json");
const WRANGLER = join(dirname(packageJson), "bin", "wrangler.js");

/** Runs wrangler and stops the script if it fails, unless the caller wants to look at the failure. */
export function wrangler(args, { capture = false, check = true, stdin = "inherit" } = {}) {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    encoding: "utf8",
    stdio: capture ? [stdin, "pipe", "pipe"] : [stdin, "inherit", "inherit"],
  });
  if (result.error) {
    console.error(`Couldn't start wrangler: ${result.error.message}`);
    process.exit(1);
  }
  if (check && result.status !== 0) {
    if (capture) process.stderr.write(result.stderr + result.stdout);
    process.exit(result.status ?? 1);
  }
  return result;
}

/** `where` is "--remote" or "--local". */
export function applyMigrations(where) {
  wrangler(["d1", "migrations", "apply", "DB", where]);
}

/**
 * Applies migrations, and reports false if the database doesn't exist yet. A first `wrangler deploy`
 * is what creates it, while the deploy button creates it beforehand.
 */
export function applyMigrationsIfDatabaseExists() {
  const result = wrangler(["d1", "migrations", "apply", "DB", "--remote"], { capture: true, check: false });
  const output = result.stdout + result.stderr;
  if (result.status === 0) {
    process.stdout.write(result.stdout);
    return true;
  }
  if (NO_DATABASE_YET.test(output)) return false;
  process.stderr.write(output);
  process.exit(result.status ?? 1);
}

/** Adds the signing key if there is none. An existing key is never replaced. */
export async function ensureSigningKey(where) {
  const result = wrangler(
    ["d1", "execute", "DB", where, "--json", "--command", "SELECT 1 FROM meta WHERE key = 'signing_key'"],
    { capture: true },
  );
  const [{ results }] = JSON.parse(result.stdout);
  if (results.length > 0) return;

  // Through a private file: a command line is visible to other processes and can end up in a build log.
  const directory = mkdtempSync(join(tmpdir(), "sweatstack-bridge-"));
  try {
    const file = join(directory, "signing-key.sql");
    const key = await generateSigningKey();
    writeFileSync(file, `INSERT OR IGNORE INTO meta (key, value) VALUES ('signing_key', '${key}');\n`, { mode: 0o600 });
    wrangler(["d1", "execute", "DB", where, "--yes", "--file", file], { capture: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log("Created the signing key.");
}
