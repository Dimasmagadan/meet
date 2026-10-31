import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// P2-7 (SPEC_SAFETY_NET_2026-10-31 §5.3): main.ts's parseAsync error mapping —
// an expected error from an async action handler prints ONE line, not a stack.
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function runMain(args: string[], envOverrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, "dist", "main.js"), ...args], {
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, ...envOverrides },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("a rejecting action yields a one-line stderr message, not a stack (P2-7)", () => {
  // sessionDir whose parent is a FILE: writeTagsState's atomic write throws
  // ENOTDIR out of the async action — previously an unhandled rejection with
  // a raw stack.
  const dir = mkdtempSync(join(tmpdir(), "meet-main-test-"));
  try {
    const fileAsDir = join(dir, "not-a-dir");
    writeFileSync(fileAsDir, "x");
    const r = runMain(["tag", join(fileAsDir, "sessions"), "some-tag"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const errOutput = r.stderr.trim();
    assert.ok(errOutput.length > 0, "expected a stderr error line");
    assert.ok(!errOutput.includes("    at "), `expected no stack, got:\n${errOutput}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--help still exits 0 (CommanderError re-throw keeps commander's contract)", () => {
  const r = runMain(["--help"]);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}`);
  assert.match(r.stdout, /Usage/);
});
