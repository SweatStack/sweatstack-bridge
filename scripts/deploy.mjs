#!/usr/bin/env node
// Applies migrations, makes sure the signing key exists, then deploys, so the code that goes live always
// finds the schema and the key it expects. The deploy button runs this through Workers Builds.
import { applyMigrations, applyMigrationsIfDatabaseExists, ensureSigningKey, wrangler } from "./lib/wrangler.mjs";

if (!applyMigrationsIfDatabaseExists()) {
  console.log("No database yet: a first deploy creates it.");
  wrangler(["deploy"]);
  applyMigrations("--remote");
}
await ensureSigningKey("--remote");
wrangler(["deploy"]);
