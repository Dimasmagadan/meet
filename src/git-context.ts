import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./storage.js";

// Local-only repo context captured at `meet start` and attachable post-hoc via
// `meet link`. Persisted into session.json + meta.md ("- Repo:" line). No
// network, no remote refs, no auth. Fail-open everywhere: a missing git binary,
// missing .git, or a corrupt meta.md never blocks recording.
export interface GitContext {
  repoPath: string;        // absolute, from `git rev-parse --show-toplevel`
  repoName: string;        // basename(repoPath)
  branch: string | null;   // null on detached HEAD
  headSha: string;         // short sha (rev-parse --short HEAD)
}

export type GitRunner = (args: string[], opts: { cwd: string }) => string;

// Synchronous on purpose: one-shot at start/link, fast, and the call sites
// (startSession, runLinkCommand) prefer sync error-or-null semantics over a
// dangling promise during setup. stdio pipes only stdout; stderr is dropped so
// "not a git repository" never leaks into the user's terminal.
export const defaultGitRunner: GitRunner = (args, opts) =>
  execFileSync("git", args, {
    cwd: opts.cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

// Walks up to the nearest .git via git's own toplevel resolution. Returns null
// when not in a repo, git is absent, or any git call fails — recording is never
// gated on this.
export function detectGitContext(cwd: string, runner: GitRunner = defaultGitRunner): GitContext | null {
  try {
    const repoPath = runner(["rev-parse", "--show-toplevel"], { cwd });
    if (!repoPath) return null;
    const headSha = runner(["rev-parse", "--short", "HEAD"], { cwd: repoPath });
    let branch: string | null = null;
    try {
      branch = runner(["symbolic-ref", "--short", "HEAD"], { cwd: repoPath });
    } catch {
      branch = null; // detached HEAD — keep headSha, drop branch
    }
    return { repoPath, repoName: basename(repoPath), branch, headSha };
  } catch {
    return null;
  }
}

export function formatRepoLine(ctx: GitContext): string {
  const where = ctx.branch ?? "detached";
  return `- Repo: ${ctx.repoName} @ ${ctx.headSha} (${where})`;
}

const REPO_LINE_RE = /^- Repo: (.+?) @ ([0-9a-f]{7,40}) \((.+)\)$/m;

export interface ParsedRepoLine {
  repoName: string;
  headSha: string;
  branch: string | null;
}

export function parseRepoLine(raw: string): ParsedRepoLine | null {
  const m = raw.match(REPO_LINE_RE);
  if (!m) return null;
  const [, repoName, headSha, where] = m;
  return { repoName, headSha, branch: where === "detached" ? null : where };
}

// Pure meta.md transformer: if a "- Repo:" line exists, replace it in place;
// otherwise insert one after the first metadata anchor (Tags → Mode → Date →
// top). Used by both `meet link` and (via writeMetaFile reading session.gitContext)
// by `meet start`/finalize.
export function applyRepoToMeta(raw: string, ctx: GitContext): string {
  const line = formatRepoLine(ctx);
  const lines = raw.split("\n");

  const repoIdx = lines.findIndex((l) => /^- Repo: /.test(l));
  if (repoIdx >= 0) {
    lines[repoIdx] = line;
    return lines.join("\n");
  }

  const findAnchor = (re: RegExp): number => {
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) return i;
    return -1;
  };
  let at = findAnchor(/^- Tags: /);
  if (at < 0) at = findAnchor(/^- Mode: /);
  if (at < 0) at = findAnchor(/^- Date: /);
  if (at < 0) {
    lines.unshift(line);
    return lines.join("\n");
  }
  lines.splice(at + 1, 0, line);
  return lines.join("\n");
}

export interface LinkRepoResult {
  metaPath: string;
  repoLine: string;
  replaced: boolean; // true when an existing "- Repo:" line was rewritten
}

// Detects repo from `repoPath` and rewrites the "- Repo:" line in the meeting's
// meta.md atomically. Throws when repoPath is not a git repo or meta.md is
// missing — the caller prints the message and exits. Pure on disk: reads meta,
// transforms, writes via writeAtomic.
export async function linkRepoToMeeting(
  meetingDir: string,
  repoPath: string,
  runner: GitRunner = defaultGitRunner,
): Promise<LinkRepoResult> {
  const ctx = detectGitContext(repoPath, runner);
  if (!ctx) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  const metaPath = join(meetingDir, "meta.md");
  if (!existsSync(metaPath)) {
    throw new Error(`No meta.md in meeting dir: ${meetingDir}`);
  }

  const original = await readFile(metaPath, "utf-8");
  const replaced = /^- Repo: /m.test(original);
  const next = applyRepoToMeta(original, ctx);
  await writeAtomic(metaPath, next);
  return { metaPath, repoLine: formatRepoLine(ctx), replaced };
}
