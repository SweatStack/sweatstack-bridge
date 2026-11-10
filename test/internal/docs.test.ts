/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import devVars from "../../.dev.vars.example?raw";
import packageJson from "../../package.json";
import { RUNBOOK_SECTION } from "../../scripts/lib/verify.mjs";

const pages = import.meta.glob("/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const repositoryFiles = Object.keys(import.meta.glob(["/*", "/scripts/**", "/migrations/*", "/src/**", "/test/**"]));

/** The anchor GitHub gives a heading. */
const anchor = (heading: string) => heading.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");
const anchorsIn = (text: string) => [...text.matchAll(/^#+ (.+)$/gm)].map(([, heading]) => anchor(heading as string));

describe("the documentation", () => {
  it("has pages to check", () => {
    expect(Object.keys(pages)).toEqual(expect.arrayContaining(["/README.md", "/DEVELOPING.md", "/RUNBOOK.md"]));
  });

  it("names only commands that exist", () => {
    const named = Object.values(pages).flatMap((text) => [...text.matchAll(/npm run ([a-z:]+)/g)].map(([, script]) => script as string));
    expect(named.length).toBeGreaterThan(0);
    const unknown = named.filter((script) => !Object.hasOwn(packageJson.scripts, script));
    expect(unknown).toEqual([]);
  });

  it("links only to files and headings that exist", () => {
    const broken: string[] = [];
    for (const [page, text] of Object.entries(pages)) {
      for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (target === undefined || /^[a-z]+:/.test(target)) continue;
        const [file, heading] = target.split("#");
        const path = `/${file}`;
        const inPage = file === "" ? text : pages[path];
        if (file !== "" && !repositoryFiles.includes(path)) broken.push(`${page}: ${target}`);
        if (heading !== undefined && !anchorsIn(inPage ?? "").includes(heading)) broken.push(`${page}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("has the heading that a sign-in for Garmin's verification lands on", () => {
    const [page, heading] = RUNBOOK_SECTION.replace("https://github.com/SweatStack/sweatstack-bridge/blob/main", "").split("#");
    expect(anchorsIn(pages[page as string] ?? "")).toContain(heading);
  });

  it("explains every setting in the runbook", () => {
    const secrets = [...devVars.matchAll(/^([A-Z_]+)=/gm)].map(([, name]) => name as string);
    const runbook = pages["/RUNBOOK.md"] ?? "";
    const missing = [...secrets, ...Object.keys(packageJson.cloudflare.bindings)].filter((name) => !runbook.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  it("says nothing about Garmin's agreements or who may use this, and doesn't call itself unfinished or the app a SweatStack app", () => {
    const forbidden = /allow-?list|garmin(?:'s)? (?:license|licence|agreement|terms|contract)|your agreement with garmin|being built|not usable yet|during the beta|sweatstack app/i;
    const everything = { ...pages, "/package.json": JSON.stringify(packageJson) };
    const found = Object.entries(everything).filter(([, text]) => forbidden.test(text)).map(([page, text]) => `${page}: ${text.match(forbidden)?.[0]}`);
    expect(found).toEqual([]);
  });

  it("keeps the README short: details belong in the runbook and the docs", () => {
    expect((pages["/README.md"] ?? "").split("\n").length).toBeLessThan(50);
  });
});
