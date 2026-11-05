/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import devVars from "../../.dev.vars.example?raw";
import packageJson from "../../package.json";
import { readConfig } from "../../src/config";
import { garmin } from "../../src/providers/garmin";
import wrangler from "../../wrangler.jsonc?raw";

const secrets = [...devVars.matchAll(/^([A-Z_]+)=/gm)].map(([, name]) => name as string);
const vars = [...(wrangler.match(/"vars": \{[\s\S]*?\n {2}\}/)?.[0] ?? "").matchAll(/^\s*"([A-Z_]+)":/gm)].map(([, name]) => name as string);

describe("the deploy form", () => {
  it("explains every field it shows, and nothing it doesn't", () => {
    expect(Object.keys(packageJson.cloudflare.bindings).sort()).toEqual([...secrets, ...vars].sort());
  });

  it("asks for every secret the bridge needs: npm run status reads this list too", () => {
    const empty = readConfig({ DB: null as never, SWEATSTACK_URL: "https://x.test" }, garmin({ env: {} as never, fetch, now: () => 0 }));
    expect(empty.ok).toBe(false);
    const missing = empty.ok ? [] : empty.problems.map((problem) => problem.replace(" is not set", ""));
    expect(missing.sort()).toEqual([...secrets].sort());
  });
});
