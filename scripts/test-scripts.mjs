// What can't run under Vitest, which runs in the Workers runtime: `npm run update` and the release notes on
// real git repositories in a temporary directory, and what needs wrangler.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Decoder, Stream } from "@garmin/fitsdk";
import { customDomain, findOrigin } from "./lib/cloudflare.mjs";
import { walk } from "./lib/walk.mjs";

const UPDATE = resolve(import.meta.dirname, "update.mjs");
const RELEASE_NOTES = resolve(import.meta.dirname, "release-notes.mjs");
const UPSTREAM_URL = "https://github.com/SweatStack/sweatstack-bridge.git";

let root, upstream, copy, env;

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const write = (dir, files) => Object.entries(files).forEach(([name, text]) => writeFileSync(join(dir, name), text));
const read = (name) => readFileSync(join(copy, name), "utf8");
const update = (...args) => spawnSync("node", [UPDATE, ...args], { cwd: copy, env, encoding: "utf8" });

const WRANGLER = (name, offers) => `{\n  "name": "${name}",\n  "main": "src/index.ts",\n  "compatibility_date": "2026-11-03",\n  "vars": {\n    "SWEATSTACK_URL": "https://app.sweatstack.no",\n    "BACKFILL_DAYS": "90",\n    "GARMIN_APP_OFFERS": "${offers}"\n  }\n}\n`;
const CHANGELOG = (...versions) => `# Changelog\n\n## Unreleased\n\nNot yet.\n\n${versions.map((version) => `## ${version}\n\nWhat ${version} did.\n`).join("\n")}`;

/** A release upstream: its files, committed and tagged. */
const release = (version, files) => {
  write(upstream, { "package.json": `${JSON.stringify({ name: "sweatstack-bridge", version }, null, 2)}\n`, ...files });
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", `Release ${version}`);
  git(upstream, "tag", `v${version}`);
};

/** What the deploy button makes: one commit, sharing no history with upstream. */
const copyMadeByTheButton = () => {
  const archive = spawnSync("git", ["archive", "v0.1.0"], { cwd: upstream, env });
  assert.equal(archive.status, 0);
  spawnSync("tar", ["-x", "-C", copy], { input: archive.stdout });
  git(copy, "init", "-q", "-b", "main");
  git(copy, "add", "-A");
  git(copy, "commit", "-qm", "source repo import");
};

/** The owner's own change, on a line upstream doesn't touch. */
const ownEdit = (name = "my-bridge") => {
  write(copy, { "wrangler.jsonc": read("wrangler.jsonc").replace('"sweatstack-bridge"', `"${name}"`) });
  git(copy, "commit", "-qam", "My own name");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-update-"));
  upstream = join(root, "upstream");
  copy = join(root, "copy");
  spawnSync("mkdir", ["-p", upstream, copy]);
  const gitconfig = join(root, "gitconfig");
  // The real upstream address leads here, so what the script does when it adds the remote is tested too.
  writeFileSync(gitconfig, `[user]\n  name = Test\n  email = test@example.com\n[url "${upstream}"]\n  insteadOf = ${UPSTREAM_URL}\n`);
  env = { ...process.env, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1" };
  git(upstream, "init", "-q", "-b", "main");
  release("0.1.0", { "wrangler.jsonc": WRANGLER("sweatstack-bridge", "activities"), "CHANGELOG.md": CHANGELOG("0.1.0"), "logo.bin": Buffer.from([0, 1, 2, 3]) });
  copyMadeByTheButton();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const twoMoreReleases = () => {
  release("0.2.0", { "wrangler.jsonc": WRANGLER("sweatstack-bridge", "activities,activity_history"), "CHANGELOG.md": CHANGELOG("0.2.0", "0.1.0"), "new.txt": "new in 0.2.0\n" });
  release("0.10.0", { "CHANGELOG.md": CHANGELOG("0.10.0", "0.2.0", "0.1.0"), "logo.bin": Buffer.from([3, 2, 1, 0]) });
};

test("moves a one-commit copy to the latest release, and keeps the owner's edit", () => {
  twoMoreReleases();
  ownEdit();
  const result = update();
  assert.equal(result.status, 0, result.stderr);

  assert.match(read("wrangler.jsonc"), /"name": "my-bridge"/);
  assert.match(read("wrangler.jsonc"), /activities,activity_history/);
  assert.equal(read("new.txt"), "new in 0.2.0\n");
  assert.equal(JSON.parse(read("package.json")).version, "0.10.0");
  assert.deepEqual([...readFileSync(join(copy, "logo.bin"))], [3, 2, 1, 0]);

  assert.match(result.stdout, /What 0\.10\.0 did/);
  assert.match(result.stdout, /What 0\.2\.0 did/);
  assert.doesNotMatch(result.stdout, /What 0\.1\.0 did/);
  assert.doesNotMatch(result.stdout, /Not yet/);
});

test("leaves it to the owner to commit, and adds nothing to their tags", () => {
  twoMoreReleases();
  const before = git(copy, "rev-parse", "HEAD");
  update();
  assert.equal(git(copy, "rev-parse", "HEAD"), before);
  assert.notEqual(git(copy, "status", "--porcelain"), "");
  assert.equal(git(copy, "tag"), "");
});

test("goes to the release it's asked for", () => {
  twoMoreReleases();
  assert.equal(update("v0.2.0").status, 0);
  assert.equal(JSON.parse(read("package.json")).version, "0.2.0");
  git(copy, "commit", "-qam", "Update");

  assert.equal(update().status, 0);
  assert.equal(JSON.parse(read("package.json")).version, "0.10.0");
});

test("marks a real clash, and says so", () => {
  twoMoreReleases();
  write(copy, { "wrangler.jsonc": read("wrangler.jsonc").replace('"GARMIN_APP_OFFERS": "activities"', '"GARMIN_APP_OFFERS": "wellness"') });
  git(copy, "commit", "-qam", "My own offers");

  const result = update("v0.2.0");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /wrangler\.jsonc/);
  assert.match(read("wrangler.jsonc"), /<<<<<<</);
  assert.equal(read("new.txt"), "new in 0.2.0\n");
});

test("refuses uncommitted changes, and changes nothing", () => {
  twoMoreReleases();
  write(copy, { "wrangler.jsonc": `${read("wrangler.jsonc")}\n` });
  const result = update();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /uncommitted/);
  assert.equal(JSON.parse(read("package.json")).version, "0.1.0");
});

test("says when there's nothing to do", () => {
  const result = update();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Already at v0\.1\.0/);
  assert.equal(git(copy, "status", "--porcelain"), "");
});

for (const [name, ask, expected] of [
  ["a release that doesn't exist", "v9.9.9", /no release v9\.9\.9/],
  ["something that isn't a release", "main", /no release main/],
]) {
  test(`refuses ${name}`, () => {
    const result = update(ask);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
  });
}

test("doesn't go backward", () => {
  twoMoreReleases();
  update();
  git(copy, "commit", "-qam", "Update");
  const result = update("v0.2.0");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /older/);
});

test("refuses a copy whose version upstream never released", () => {
  twoMoreReleases();
  write(copy, { "package.json": `${JSON.stringify({ version: "0.0.0" })}\n` });
  git(copy, "commit", "-qam", "Odd version");
  const result = update();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /never released/);
});

test("uses an upstream remote the owner already has", () => {
  twoMoreReleases();
  git(copy, "remote", "add", "upstream", upstream);
  assert.equal(update().status, 0);
});

const notes = (tag, cwd = upstream) => spawnSync("node", [RELEASE_NOTES, tag], { cwd, env, encoding: "utf8" });

test("release notes are that release's section and nothing else", () => {
  twoMoreReleases();
  const result = notes("v0.10.0");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "## 0.10.0\n\nWhat 0.10.0 did.");
});

test("release notes refuse a tag package.json doesn't agree with, or a release with no section", () => {
  release("0.2.0", { "CHANGELOG.md": CHANGELOG("0.1.0") });
  assert.match(notes("v0.3.0").stderr, /package\.json says 0\.2\.0/);
  assert.match(notes("v0.2.0").stderr, /no section for 0\.2\.0/);
});

test("finds a custom domain, and ignores a route that isn't one", () => {
  assert.equal(customDomain(undefined), null);
  assert.equal(customDomain(["example.com/*", { pattern: "zone.example/*", zone_name: "zone.example" }]), null);
  assert.equal(customDomain([{ pattern: "bridge.example", custom_domain: true }]), "https://bridge.example");
});

test("takes the owner's address first, then the custom domain, and only asks for https", async () => {
  const config = { routes: [{ pattern: "bridge.example", custom_domain: true }] };
  assert.equal(await findOrigin(config, ["node", "x", "--origin", "https://mine.example/"]), "https://mine.example");
  assert.equal(await findOrigin(config, ["node", "x"]), "https://bridge.example");
  await assert.rejects(findOrigin(config, ["node", "x", "--origin", "http://mine.example"]), /https/);
});

test("the walk for Garmin's verification is a valid 10-minute walk ending when asked, with nothing about a person", () => {
  const endsAt = new Date("2026-11-10T21:15:30.700Z");
  const decoder = new Decoder(Stream.fromByteArray(walk(endsAt)));
  assert.ok(decoder.isFIT() && decoder.checkIntegrity());
  const { messages, errors } = decoder.read();
  assert.deepEqual(errors, []);
  const [session] = messages.sessionMesgs;
  assert.equal(session.sport, "walking");
  assert.equal(session.totalElapsedTime, 600);
  assert.equal(session.timestamp.toISOString(), "2026-11-10T21:15:30.000Z");
  assert.equal(messages.recordMesgs.length, 601);
  const fields = new Set(Object.values(messages).flat().flatMap((message) => Object.keys(message)));
  for (const personal of ["positionLat", "positionLong", "heartRate", "serialNumber"]) assert.ok(!fields.has(personal), personal);
  assert.equal(messages.userProfileMesgs, undefined);
  assert.notDeepEqual(walk(new Date(endsAt.getTime() + 60_000)), walk(endsAt));
});
