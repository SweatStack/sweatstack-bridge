#!/usr/bin/env node
// Runs the Worker locally against a local database, with its migrations applied and a signing key.
import { applyMigrations, ensureSigningKey, wrangler } from "./lib/wrangler.mjs";

applyMigrations("--local");
await ensureSigningKey("--local");
wrangler(["dev"]);
