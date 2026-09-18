#!/usr/bin/env node
// Cuts a release: bumps package.json version, regenerates CHANGELOG.md from
// Conventional Commits since the last tag, commits, and creates an annotated
// git tag. Never pushes — that's a separate, explicit step.
//
// Usage:
//   node scripts/release.mjs patch|minor|major
//   node scripts/release.mjs --version 1.2.0
//   node scripts/release.mjs --version 1.0.0 --dry-run

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const pkgPath = join(repoRoot, "package.json");
const changelogPath = join(repoRoot, "CHANGELOG.md");

const TYPE_TO_SECTION = {
  feat: "Added",
  fix: "Fixed",
  perf: "Changed",
  refactor: "Changed",
};

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--version=")) args.version = arg.slice("--version=".length);
    else if (arg === "--version") args.versionFlag = true;
    else if (args.versionFlag) {
      args.version = arg;
      args.versionFlag = false;
    } else if (["patch", "minor", "major"].includes(arg)) args.bump = arg;
    else throw new Error(`Unrecognized argument: ${arg}`);
  }
  if (!args.version && !args.bump) {
    throw new Error("Usage: release.mjs <patch|minor|major> | --version X.Y.Z [--dry-run]");
  }
  return args;
}

function bumpVersion(current, bump) {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`package.json version "${current}" is not plain semver`);
  let [, major, minor, patch] = match.map(Number);
  if (bump === "major") { major += 1; minor = 0; patch = 0; }
  else if (bump === "minor") { minor += 1; patch = 0; }
  else { patch += 1; }
  return `${major}.${minor}.${patch}`;
}

function lastTag() {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function collectCommits(since) {
  const range = since ? `${since}..HEAD` : "HEAD";
  const raw = git(["log", range, "--no-merges", "--format=%s%x01%b%x02"]);
  if (!raw) return [];
  return raw
    .split("\x02")
    .map((entry) => entry.replace(/^\n+/, "").trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject, body = ""] = entry.split("\x01");
      return { subject: subject.trim(), body: body.trim() };
    });
}

function categorize(commits) {
  const sections = { Added: [], Changed: [], Fixed: [] };
  const conventional = /^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/;
  for (const { subject, body } of commits) {
    const match = subject.match(conventional);
    if (!match) continue;
    const [, type, , scope, breaking, description] = match;
    const section = TYPE_TO_SECTION[type];
    if (!section) continue;
    const isBreaking = Boolean(breaking) || /BREAKING CHANGE:/.test(body);
    const prefix = scope ? `**${scope}:** ` : "";
    const marker = isBreaking ? "**BREAKING:** " : "";
    sections[section].push(`- ${marker}${prefix}${description}`);
  }
  return sections;
}

function renderSection(version, date, sections) {
  const lines = [`## [${version}] - ${date}`];
  for (const name of ["Added", "Changed", "Fixed"]) {
    if (sections[name].length === 0) continue;
    lines.push("", `### ${name}`, ...sections[name]);
  }
  if (lines.length === 1) lines.push("", "_No user-facing changes._");
  return lines.join("\n");
}

function updateChangelog(newSection) {
  const header = "# Changelog\n\nAll notable changes to this project are documented here.\nFormat follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).\n\n## [Unreleased]\n";
  if (!existsSync(changelogPath)) {
    return `${header}\n${newSection}\n`;
  }
  const current = readFileSync(changelogPath, "utf8");
  const marker = "## [Unreleased]";
  const idx = current.indexOf(marker);
  if (idx === -1) {
    return `${header}\n${newSection}\n\n${current.trim()}\n`;
  }
  const before = current.slice(0, idx + marker.length);
  const after = current.slice(idx + marker.length);
  return `${before}\n\n${newSection}\n${after.replace(/^\s*/, "\n")}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun) {
    // Ignores untracked files on purpose — only tracked-file changes should
    // block a release; stray untracked scratch files are common in this repo.
    const status = git(["status", "--porcelain", "--untracked-files=no"]);
    if (status) {
      console.error("Tracked files have uncommitted changes. Commit or stash them before releasing.");
      process.exit(1);
    }
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const nextVersion = args.version ?? bumpVersion(pkg.version, args.bump);
  if (!/^\d+\.\d+\.\d+$/.test(nextVersion)) {
    throw new Error(`--version must be plain semver (X.Y.Z), got "${nextVersion}"`);
  }

  const since = lastTag();
  const commits = collectCommits(since);
  const sections = categorize(commits);
  const date = new Date().toISOString().slice(0, 10);
  const newSection = renderSection(nextVersion, date, sections);
  const nextChangelog = updateChangelog(newSection);

  console.log(newSection);
  console.log("");
  console.log(`Previous tag: ${since ?? "(none — first release)"}`);
  console.log(`New version: ${pkg.version} -> ${nextVersion}`);

  if (args.dryRun) {
    console.log("\n--dry-run: no files changed, nothing committed.");
    return;
  }

  pkg.version = nextVersion;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(changelogPath, nextChangelog);

  execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: repoRoot, stdio: "ignore" });

  git(["add", "package.json", "package-lock.json", "CHANGELOG.md"]);
  git(["commit", "-m", `chore(release): v${nextVersion}`]);
  git(["tag", "-a", `v${nextVersion}`, "-m", newSection]);

  console.log(`\nCommitted and tagged v${nextVersion}. Review with:\n  git show HEAD\n  git show v${nextVersion}`);
  console.log(`\nWhen ready, push with:\n  git push && git push origin v${nextVersion}`);
}

main();
