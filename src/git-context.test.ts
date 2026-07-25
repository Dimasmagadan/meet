import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectGitContext,
  formatRepoLine,
  parseRepoLine,
  applyRepoToMeta,
  linkRepoToMeeting,
  type GitRunner,
  type GitContext,
} from "./git-context.js";

describe("detectGitContext", () => {
  it("returns repo context with branch", () => {
    const calls: string[][] = [];
    const runner: GitRunner = (args, opts) => {
      calls.push([args.join(" "), opts.cwd]);
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/Users/x/meet";
      if (args[0] === "rev-parse" && args[1] === "--short" && args[2] === "HEAD") return "abc1234";
      if (args[0] === "symbolic-ref" && args[1] === "--short" && args[2] === "HEAD") return "main";
      throw new Error("unexpected: " + args.join(" "));
    };
    const ctx = detectGitContext("/Users/x/meet/src", runner);
    assert.deepEqual(ctx, { repoPath: "/Users/x/meet", repoName: "meet", branch: "main", headSha: "abc1234" });
    // toplevel resolved from the passed cwd; subsequent calls hit the repo root
    assert.equal(calls[0][1], "/Users/x/meet/src");
    assert.ok(calls.slice(1).every(([, cwd]) => cwd === "/Users/x/meet"));
  });

  it("keeps headSha, drops branch on detached HEAD", () => {
    const runner: GitRunner = (args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/repo";
      if (args[0] === "rev-parse" && args[1] === "--short") return "deadbee";
      if (args[0] === "symbolic-ref") throw new Error("detached");
      throw new Error("unexpected");
    };
    const ctx = detectGitContext("/repo", runner);
    assert.equal(ctx?.headSha, "deadbee");
    assert.equal(ctx?.branch, null);
    assert.equal(ctx?.repoName, "repo");
  });

  it("returns null when not in a repo", () => {
    const runner: GitRunner = () => { throw new Error("not a git repository"); };
    assert.equal(detectGitContext("/tmp", runner), null);
  });

  it("returns null when git binary is missing (any failure fails open)", () => {
    const runner: GitRunner = () => { throw new Error("ENOENT"); };
    assert.equal(detectGitContext("/anywhere", runner), null);
  });
});

describe("formatRepoLine / parseRepoLine round-trip", () => {
  it("formats with branch", () => {
    const ctx: GitContext = { repoPath: "/r", repoName: "meet", branch: "main", headSha: "abc1234" };
    assert.equal(formatRepoLine(ctx), "- Repo: meet @ abc1234 (main)");
  });

  it("formats detached as (detached) and parses back to null branch", () => {
    const ctx: GitContext = { repoPath: "/r", repoName: "meet", branch: null, headSha: "abc1234" };
    const line = formatRepoLine(ctx);
    assert.equal(line, "- Repo: meet @ abc1234 (detached)");
    const parsed = parseRepoLine(line);
    assert.deepEqual(parsed, { repoName: "meet", headSha: "abc1234", branch: null });
  });

  it("parses a branch line back", () => {
    const parsed = parseRepoLine("- Repo: meet @ abc1234 (feature/l1)");
    assert.deepEqual(parsed, { repoName: "meet", headSha: "abc1234", branch: "feature/l1" });
  });

  it("returns null on non-matching lines", () => {
    assert.equal(parseRepoLine("# Title"), null);
    assert.equal(parseRepoLine("- Tags: foo"), null);
    assert.equal(parseRepoLine(""), null);
  });
});

describe("applyRepoToMeta", () => {
  const ctx: GitContext = { repoPath: "/r", repoName: "meet", branch: "main", headSha: "abc1234" };

  it("inserts after Tags when no Repo line exists", () => {
    const raw = [
      "# Standup",
      "",
      "- Date: 25.07.2026 14:30",
      "- Mode: full",
      "- Tags: work",
      "",
    ].join("\n");
    const out = applyRepoToMeta(raw, ctx);
    const lines = out.split("\n");
    const tagsIdx = lines.findIndex((l) => l.startsWith("- Tags:"));
    const repoIdx = lines.findIndex((l) => l.startsWith("- Repo:"));
    assert.ok(repoIdx === tagsIdx + 1);
    assert.equal(lines[repoIdx], "- Repo: meet @ abc1234 (main)");
  });

  it("inserts after Mode when Tags line is absent", () => {
    const raw = "# T\n\n- Date: 25.07.2026 14:30\n- Mode: mic\n";
    const out = applyRepoToMeta(raw, ctx);
    const lines = out.split("\n");
    const modeIdx = lines.findIndex((l) => l.startsWith("- Mode:"));
    assert.ok(lines[modeIdx + 1].startsWith("- Repo:"));
  });

  it("replaces an existing Repo line in place (meet link re-attach)", () => {
    const raw = [
      "# T",
      "",
      "- Date: 25.07.2026 14:30",
      "- Mode: full",
      "- Tags: a",
      "- Repo: oldrepo @ 0000000 (oldbranch)",
      "",
    ].join("\n");
    const out = applyRepoToMeta(raw, ctx);
    const lines = out.split("\n");
    const repoCount = lines.filter((l) => l.startsWith("- Repo:")).length;
    assert.equal(repoCount, 1, "no duplicate Repo line");
    const repoIdx = lines.findIndex((l) => l.startsWith("- Repo:"));
    assert.equal(lines[repoIdx], "- Repo: meet @ abc1234 (main)");
    // positioned right after Tags (same slot as before)
    const tagsIdx = lines.findIndex((l) => l.startsWith("- Tags:"));
    assert.equal(repoIdx, tagsIdx + 1);
  });

  it("is idempotent", () => {
    const raw = "# T\n\n- Date: 25.07.2026 14:30\n- Mode: full\n- Tags: a\n";
    const once = applyRepoToMeta(raw, ctx);
    const twice = applyRepoToMeta(once, ctx);
    assert.equal(once, twice);
  });
});

describe("linkRepoToMeeting", () => {
  it("writes the Repo line into meta.md and reports replaced=false on first link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-link-"));
    try {
      writeFileSync(join(dir, "meta.md"), "# T\n\n- Date: 25.07.2026 14:30\n- Mode: full\n- Tags: a\n");
      const runner: GitRunner = (args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/Users/x/meet";
        if (args[0] === "rev-parse" && args[1] === "--short") return "abc1234";
        if (args[0] === "symbolic-ref") return "main";
        throw new Error("unexpected");
      };
      const res = await linkRepoToMeeting(dir, "/Users/x/meet", runner);
      assert.equal(res.replaced, false);
      const after = readFileSync(join(dir, "meta.md"), "utf-8");
      assert.match(after, /- Repo: meet @ abc1234 \(main\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites an existing Repo line and reports replaced=true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-link-"));
    try {
      writeFileSync(
        join(dir, "meta.md"),
        "# T\n\n- Date: 25.07.2026 14:30\n- Mode: full\n- Tags: a\n- Repo: old @ 0000000 (old)\n",
      );
      const runner: GitRunner = (args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/Users/x/meet";
        if (args[0] === "rev-parse" && args[1] === "--short") return "abc1234";
        if (args[0] === "symbolic-ref") return "main";
        throw new Error("unexpected");
      };
      const res = await linkRepoToMeeting(dir, "/Users/x/meet", runner);
      assert.equal(res.replaced, true);
      const after = readFileSync(join(dir, "meta.md"), "utf-8");
      assert.doesNotMatch(after, /old @ 0000000/);
      assert.match(after, /- Repo: meet @ abc1234 \(main\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when repoPath is not a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-link-"));
    try {
      writeFileSync(join(dir, "meta.md"), "# T\n");
      const runner: GitRunner = () => { throw new Error("not a repo"); };
      await assert.rejects(() => linkRepoToMeeting(dir, "/nope", runner), /Not a git repository/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws when meta.md is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-link-"));
    try {
      const runner: GitRunner = (args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/Users/x/meet";
        if (args[0] === "rev-parse" && args[1] === "--short") return "abc1234";
        if (args[0] === "symbolic-ref") return "main";
        throw new Error("unexpected");
      };
      await assert.rejects(() => linkRepoToMeeting(dir, "/Users/x/meet", runner), /No meta.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes atomically (no .tmp leftover in the meeting dir)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meet-link-"));
    try {
      writeFileSync(join(dir, "meta.md"), "# T\n\n- Mode: full\n");
      const runner: GitRunner = (args) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return "/r";
        if (args[0] === "rev-parse" && args[1] === "--short") return "abc1234";
        if (args[0] === "symbolic-ref") return "main";
        throw new Error("unexpected");
      };
      await linkRepoToMeeting(dir, "/r", runner);
      const leftover = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
      assert.deepEqual(leftover, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
