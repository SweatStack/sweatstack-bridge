import { env } from "cloudflare:test";
import { createApp } from "../../src/app";
import type { Env } from "../../src/config";
import { network, type Handler } from "./network";

export const COMPLETE_SETTINGS = {
  SWEATSTACK_URL: "https://sweatstack.test",
  SWEATSTACK_APP_ID: "test-app",
  SWEATSTACK_CLIENT_SECRET: "test-client-secret",
  GARMIN_CLIENT_ID: "test-garmin-id",
  GARMIN_CLIENT_SECRET: "test-garmin-secret",
  BACKFILL_DAYS: "90",
};

export interface TestBridgeOptions {
  settings?: Record<string, string>;
  hosts?: Record<string, Handler>;
}

/** The bridge as the outside world reaches it: over HTTP, on its own origin. */
export function testBridge({ settings = COMPLETE_SETTINGS, hosts = {} }: TestBridgeOptions = {}) {
  const clock = { now: 1_800_000_000 };
  const bridgeEnv: Env = { DB: env.DB, ...settings };
  const app = createApp({ env: bridgeEnv, fetch: network(hosts), now: () => clock.now });
  return {
    clock,
    origin: "https://bridge.test",
    request: (path: string, init?: RequestInit) => app.request(`https://bridge.test${path}`, init, bridgeEnv),
  };
}
