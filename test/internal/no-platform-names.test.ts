/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("/src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const everything = import.meta.glob(["/src/**", "/test/**", "/scripts/**", "/migrations/**"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;

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

describe("the code", () => {
  it("cites nothing a reader of this repository can't open: the plans behind it aren't public", () => {
    const privateReference = /\b097\b|\(B\d{1,2}\)|\bB\d{1,2}:|\bD\d{2}\b|\bapp\/\w+\.py\b|[Uu]se case \d/;
    const offenders = Object.entries(everything)
      .filter(([path]) => !path.endsWith("no-platform-names.test.ts") && !path.includes("/fixtures/"))
      .filter(([, source]) => privateReference.test(source))
      .map(([path, source]) => `${path}: ${source.match(privateReference)?.[0]}`);
    expect(offenders).toEqual([]);
  });
});
