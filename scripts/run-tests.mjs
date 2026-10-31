#!/usr/bin/env node
// Test runner wrapper (SPEC_SAFETY_NET_2026-10-31 §2.1, §2.4, §7 row 8).
//
// Why this exists: `node --test dist/**/*.test.js` never worked in CI — npm
// runs scripts with sh, which does not globstar-expand, so the literal string
// reached Node 20's runner, which matched zero test files and "passed" an
// empty suite (P1-1: six weeks of red CI reported as healthy). The sh layer
// is bypassed by spawning node directly from this script.
//
// Test-file selection: the directory form (`node --test dist`) is preferred
// — no glob at any version — but Node 24.x treats a bare directory as a
// module path and fails (verified: dir form works on 26, fails on 24), so the
// wrapper only attempts it on Node >= 26 and otherwise goes straight to the
// glob form, which Node 24/26 expand themselves. Either way the REAL safety
// net is the parsed-count guard below: a runner that matched zero files can
// never report success.
//
// Guards layered on top of the plain run:
//   - the parsed test count must clear MIN_EXPECTED_TESTS, so a runner that
//     silently scanned the wrong directory fails loudly instead of passing;
//   - no src/*.ts may contain a literal NUL byte (git treats the file as
//     binary; P3 row 8).
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// SPEC_SAFETY_NET_2026-10-31 §2.4. Current suite: ~800 tests. If the suite
// legitimately shrinks below this floor, lower it in the same commit that
// explains why.
const MIN_EXPECTED_TESTS = 100;

// Accepts both summary forms the test runner emits:
//   spec reporter: "ℹ tests 739"
//   TAP:           "# tests 739"
export function parseTestCount(output) {
  const spec = output.match(/^ℹ\s+tests\s+(\d+)\s*$/m);
  if (spec) return Number(spec[1]);
  const tap = output.match(/^#\s+tests\s+(\d+)\s*$/m);
  if (tap) return Number(tap[1]);
  return null;
}

// A single leaked handle (e.g. recorder.test.js abandoning a live Recorder —
// CI_LINUX_FINDINGS_2026-10-31.md §2) hangs the file's process forever, and
// node --test then waits forever with it. Kill and fail loudly instead: the
// hang message prints at kill time and main() exits 1 before the count guard
// (whose "matched zero test files" diagnosis would be false there, §7.3.3).
// One window per full `npm test`: a timed-out attempt never triggers the
// glob retry, so 10 min is the true ceiling.
const TEST_RUN_TIMEOUT_MS = 10 * 60_000;

// Returns the src/*.ts files containing a literal NUL byte.
export async function findNulByteFiles(srcDir) {
  const bad = [];
  for (const entry of await readdir(srcDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const buf = await readFile(join(srcDir, entry.name));
    if (buf.includes(0)) bad.push(entry.name);
  }
  return bad;
}

// Kill the runner AND its whole process group (CI_LINUX_FINDINGS §7.3.4):
// node --test spawns a child per test file, and SIGKILLing only the runner
// orphaned the per-file child — a local `npm test` could leave a stray node
// behind even after the "loud" timeout failure. The runner is spawned
// detached so it leads its own process group and the group kill reaches
// everything.
function killTestRunTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

function runNodeTest(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "inherit"],
      detached: process.platform !== "win32",
    });
    let output = "";
    let timedOut = false;
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTestRunTree(child);
    }, TEST_RUN_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        console.error(`\n[run-tests] test run exceeded ${TEST_RUN_TIMEOUT_MS / 60_000} min and was killed — a test file is hanging. Refusing to report success.`);
        resolve({ code: 1, output: "", timedOut: true });
        return;
      }
      resolve({ code: code ?? 1, output, timedOut: false });
    });
  });
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, "dist");

  const nulFiles = await findNulByteFiles(join(root, "src"));
  if (nulFiles.length > 0) {
    console.error(`NUL byte(s) found in source — git will treat these files as binary: ${nulFiles.join(", ")}`);
    process.exit(1);
  }

  // Directory-arg support probed by version (CI_LINUX_FINDINGS §7.3.3): on
  // Node 24 the bare directory is treated as a module path and every run
  // dumped a MODULE_NOT_FOUND stack before the glob retry. Verified boundary:
  // dir form works on 26, fails on 24. A future Node that drops it again just
  // falls through the retry below — fail-open to the glob form.
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  let { code, output, timedOut } = await runNodeTest(
    root,
    nodeMajor >= 26 ? [distDir] : [join("dist", "**", "*.test.js")],
  );
  if (!timedOut && code !== 0 && output.includes("Cannot find module") && output.includes(distDir)) {
    // Directory-as-module failure: retry with the glob form the runner
    // expands itself. A zero-match glob still lands in the count guard
    // below, so this fallback can never silently pass.
    console.error(`\n[run-tests] bare-directory test args unsupported on ${process.version}; retrying with the runner-expanded glob`);
    ({ code, output, timedOut } = await runNodeTest(root, [join("dist", "**", "*.test.js")]));
  }

  if (timedOut) {
    // The hang message already printed at kill time; the partial output has
    // no summary line but the run DID match files — reaching the count guard
    // here would misdiagnose "matched zero test files" (§7.3.3).
    process.exit(1);
  }

  const count = parseTestCount(output);
  if (count === null || count < 1) {
    console.error(`\n[run-tests] No test summary found — the runner matched zero test files. Refusing to report success (SPEC_SAFETY_NET_2026-10-31 §2.1).`);
    process.exit(1);
  }
  if (count < MIN_EXPECTED_TESTS) {
    console.error(`\n[run-tests] Only ${count} tests ran (floor: ${MIN_EXPECTED_TESTS}) — the runner likely scanned the wrong directory or the suite shrank. Refusing to report success (SPEC_SAFETY_NET_2026-10-31 §2.4).`);
    process.exit(1);
  }

  process.exit(code);
}

// Only run when executed directly — src/test-runner.test.ts imports the pure
// helpers above and must not trigger a recursive test run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
