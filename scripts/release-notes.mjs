#!/usr/bin/env node
// Prints the changelog's section for a tag, for the release workflow. It refuses a tag that doesn't match
// package.json, because that's how a copy knows its version and so what `npm run update` compares.
import { readFileSync } from "node:fs";
import { changelogAfter, isReleaseTag } from "./lib/versions.mjs";

const tag = process.argv[2] ?? "";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));

function stop(message) {
  console.error(message);
  process.exit(1);
}

if (!isReleaseTag(tag)) stop(`${tag} isn't a release tag like v1.2.0.`);
if (tag !== `v${version}`) stop(`The tag is ${tag}, but package.json says ${version}.`);
const notes = changelogAfter(readFileSync("CHANGELOG.md", "utf8"), null).split(/^(?=## )/m)[0]?.trim() ?? "";
if (!notes.startsWith(`## ${version}`)) stop(`CHANGELOG.md has no section for ${version}.`);
console.log(notes);
