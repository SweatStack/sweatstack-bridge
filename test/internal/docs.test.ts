/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import devVars from "../../.dev.vars.example?raw";
import packageJson from "../../package.json";

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

  it("explains every setting in the README", () => {
    const secrets = [...devVars.matchAll(/^([A-Z_]+)=/gm)].map(([, name]) => name as string);
    const readme = pages["/README.md"] ?? "";
    const missing = [...secrets, ...Object.keys(packageJson.cloudflare.bindings)].filter((name) => !readme.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
