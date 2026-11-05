/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("core code", () => {
  it("has files to check", () => {
    expect(Object.keys(sources)).toContain("/src/app.ts");
  });

  it("never names a platform: everything specific to one lives in src/providers", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.startsWith("/src/providers/"))
      .filter(([, source]) => /garmin/i.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
