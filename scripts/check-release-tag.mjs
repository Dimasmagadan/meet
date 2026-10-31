#!/usr/bin/env node
// Release gate (SPEC_SAFETY_NET_2026-10-31 §2.5.2): the pushed tag must match
// package.json's version, otherwise the release notes extractor pulls the
// wrong section and the release ships under a version that was never built.
import { readFile } from "node:fs/promises";

const tag = process.argv[2];
if (!tag) {
  console.error("usage: node scripts/check-release-tag.mjs <tag>");
  process.exit(1);
}

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf-8"));
const expected = `v${pkg.version}`;
if (tag !== expected) {
  console.error(`Tag ${tag} does not match package.json version (${expected}). Bump the version or push the right tag.`);
  process.exit(1);
}
console.log(`Tag ${tag} matches package.json (${expected})`);
