#!/usr/bin/env node
// Prints the CHANGELOG.md body for one version (no header line), for use as
// GitHub Release notes. Usage: node scripts/extract-release-notes.mjs 1.2.0

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const changelogPath = join(__dirname, "..", "CHANGELOG.md");

const version = process.argv[2]?.replace(/^v/, "");
if (!version) {
  console.error("Usage: extract-release-notes.mjs <version>");
  process.exit(1);
}

const changelog = readFileSync(changelogPath, "utf8");
const headerRe = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\].*$`, "m");
const startMatch = headerRe.exec(changelog);
if (!startMatch) {
  console.error(`No CHANGELOG.md section found for version ${version}`);
  process.exit(1);
}

const start = startMatch.index + startMatch[0].length;
const rest = changelog.slice(start);
const nextHeader = /^## \[/m.exec(rest);
const body = nextHeader ? rest.slice(0, nextHeader.index) : rest;

process.stdout.write(body.trim() + "\n");
