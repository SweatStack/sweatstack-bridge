#!/usr/bin/env node
// Moves this copy to a newer release, with git alone: `npm run update`, or `npm run update -- v0.2.0`.
// A copy made with the deploy button shares no history with upstream, so this applies the difference
// between two releases as a three-way merge, which keeps your own edits. It commits nothing.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { changelogAfter, compareTags, isReleaseTag, latestTag } from "./lib/versions.mjs";

const UPSTREAM_URL = "https://github.com/SweatStack/sweatstack-bridge.git";
/** Out of the way of `git tag`, so upstream's releases never mix with the owner's own tags. */
const RELEASES = "refs/bridge-releases";

function run(args, options = {}) {
  return spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
}

function git(...args) {
  const result = run(args);
  if (result.status !== 0) stop(`git ${args[0]} failed:\n${result.stderr}`);
  return result.stdout;
}

function stop(message) {
  console.error(message);
  process.exit(1);
}

if (run(["rev-parse", "--is-inside-work-tree"]).status !== 0) stop("This isn't a git repository: run this in your copy of the bridge.");
if (git("status", "--porcelain").trim() !== "") stop("You have uncommitted changes. Commit or stash them first, so an update can be undone on its own.");

if (run(["remote", "get-url", "upstream"]).status !== 0) git("remote", "add", "upstream", UPSTREAM_URL);
git("fetch", "--quiet", "--no-tags", "--force", "upstream", `+refs/tags/v*:${RELEASES}/v*`);

const releases = git("for-each-ref", "--format=%(refname:lstrip=2)", RELEASES).split("\n").filter(isReleaseTag);
const current = `v${JSON.parse(readFileSync("package.json", "utf8")).version}`;
const target = process.argv[2] ?? latestTag(releases);

if (target === null) stop("Upstream has no releases yet.");
if (!isReleaseTag(target) || !releases.includes(target)) stop(`Upstream has no release ${target}. It has: ${releases.join(", ")}`);
if (!releases.includes(current)) stop(`This copy says it's at ${current}, which upstream never released, so there's nothing to compare it with.`);
if (compareTags(target, current) === 0) {
  console.log(`Already at ${current}.`);
  process.exit(0);
}
if (compareTags(target, current) < 0) stop(`${target} is older than this copy, at ${current}. Updates only go forward: use git to go back.`);

// --binary, because a patch without it can't carry a file that isn't text.
const difference = git("diff", "--binary", `${RELEASES}/${current}`, `${RELEASES}/${target}`);
const applied = run(["apply", "--3way", "--index"], { input: difference });
const conflicts = git("diff", "--name-only", "--diff-filter=U").trim();
if (applied.status !== 0 && conflicts === "") stop(`The update didn't apply, and nothing has changed:\n${applied.stderr}`);

console.log(`Updated from ${current} to ${target}.\n`);
const notes = changelogAfter(git("show", `${RELEASES}/${target}:CHANGELOG.md`), current);
if (notes !== "") console.log(`${notes}\n`);

if (conflicts !== "") {
  console.log(`These files clash with your own edits. Look for the <<<<<<< markers, fix them, and git add each one:\n${conflicts}\n`);
}
console.log("Next: npm ci, npm test, review the changes, then commit and push. Your deploy then applies any new migrations.");
process.exitCode = conflicts === "" ? 0 : 1;
