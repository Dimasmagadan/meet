import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { createProgram, parseNonNegativeInteger, parsePositiveInteger, validateCalendarHardCap } from "./cli.js";

// The real option definitions are what's under test, so each case builds the
// actual program and swaps only the action body for a capture stub (commander
// lets .action() overwrite a prior handler). This pins the seam where the
// commander `--no-` negation trap shipped B2: the value must land under the
// exact key the production action reads.
async function captureStart(args: string[]): Promise<Record<string, unknown>> {
  const program = createProgram();
  let captured: Record<string, unknown> | null = null;
  const start = program.commands.find((c) => c.name() === "start");
  assert.ok(start, "start command exists");
  start!.action(async (_title: string, opts: Record<string, unknown>) => {
    captured = opts;
  });
  await program.parseAsync(["start", ...args], { from: "user" });
  assert.ok(captured, "start action ran");
  return captured!;
}

test("start: --text-timeout parses into the key the action reads (B2)", async () => {
  const opts = await captureStart(["--text-timeout", "5", "Standup"]);
  assert.equal(opts.textTimeout, 5);
  assert.equal(opts.noTextTimeout, undefined);
});

test("start: --text-timeout 0 parses (disabled) rather than being dropped", async () => {
  const opts = await captureStart(["--text-timeout", "0"]);
  assert.equal(opts.textTimeout, 0);
});

test("start: --max-duration and --silence parse as non-negative integers", async () => {
  const opts = await captureStart(["--max-duration", "90", "--silence", "30"]);
  assert.equal(opts.maxDuration, 90);
  assert.equal(opts.silence, 30);
});

test("start: calendar hard cap parses and validates before side effects", async () => {
  const opts = await captureStart(["--max-duration", "23", "--calendar-hard-cap", "30"]);
  assert.equal(opts.calendarHardCap, 30);
  assert.doesNotThrow(() => validateCalendarHardCap(23, 30));
  for (const pair of [[undefined, 30], [0, 30], [30, 30], [31, 30], [23, 0], [23, Infinity], [23, 2.5]] as const) {
    assert.throws(() => validateCalendarHardCap(pair[0], pair[1]));
  }
  for (const bad of ["0", "-1", "1.5", "Infinity"]) {
    assert.throws(() => parsePositiveInteger(bad));
  }
});

test("start: --no-summary lands under the negated key as false (the working case)", async () => {
  const opts = await captureStart(["--no-summary"]);
  assert.equal(opts.summary, false);
});

test("start: boolean + value flags compose without clobbering each other", async () => {
  const opts = await captureStart(["--mic", "--headless", "--text-timeout", "7", "--voice-processing"]);
  assert.equal(opts.mic, true);
  assert.equal(opts.headless, true);
  assert.equal(opts.voiceProcessing, true);
  assert.equal(opts.textTimeout, 7);
});

test("start: defaults match the documented values when nothing is passed", async () => {
  const opts = await captureStart(["meeting"]);
  assert.equal(opts.silence, 0);
  assert.equal(opts.summary, true);
});

test("start: rejects an unknown option instead of silently ignoring it", async () => {
  const program = createProgram();
  const start = program.commands.find((c) => c.name() === "start")!;
  // exitOverride must land on the subcommand that owns the option — the
  // program-level override doesn't propagate, and without it commander
  // process.exit()s the test runner.
  start.exitOverride();
  start.action(async () => {});
  await assert.rejects(() => program.parseAsync(["start", "--definitely-not-a-flag"], { from: "user" }));
});

test("start: rejects a negative value for --text-timeout at parse time", async () => {
  const program = createProgram();
  const start = program.commands.find((c) => c.name() === "start")!;
  start.exitOverride();
  start.action(async () => {});
  await assert.rejects(() => program.parseAsync(["start", "--text-timeout", "-5"], { from: "user" }));
});

test("parseNonNegativeInteger: accepts 0 and positive integers", () => {
  assert.equal(parseNonNegativeInteger("0"), 0);
  assert.equal(parseNonNegativeInteger("42"), 42);
  assert.equal(parseNonNegativeInteger("9007199254740991"), 9007199254740991);
});

test("parseNonNegativeInteger: rejects negatives, non-integers, and non-numbers", () => {
  assert.throws(() => parseNonNegativeInteger("-1"));
  assert.throws(() => parseNonNegativeInteger("1.5"));
  assert.throws(() => parseNonNegativeInteger("abc"));
  assert.throws(() => parseNonNegativeInteger(""));
});

test("parsePositiveInteger: rejects zero but accepts positives", () => {
  assert.equal(parsePositiveInteger("1"), 1);
  assert.throws(() => parsePositiveInteger("0"));
  assert.throws(() => parsePositiveInteger("-3"));
});

test("createProgram: returns a commander Command named meet", () => {
  const program = createProgram();
  assert.ok(program instanceof Command);
  assert.equal(program.name(), "meet");
  const names = program.commands.map((c) => c.name());
  for (const expected of ["start", "setup", "doctor", "list", "finalize", "status", "transcribe", "dashboard", "model", "rename", "retitle", "ask", "link", "tag", "tags", "bin-path", "speakers"]) {
    assert.ok(names.includes(expected), `command ${expected} is registered`);
  }
});

// --- P2-7 (SPEC_SAFETY_NET_2026-10-31 §5.3): exit-code honesty --------------

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommanderError } from "commander";
import { handleActionError, resolveAttendees } from "./cli.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function runCli(args: string[], envOverrides: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(join(tmpdir(), "meet-cli-home-"));
  try {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, "dist", "main.js"), ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, HOME: home, ...envOverrides },
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("meet setup exits 1 when checks fail (P2-7)", () => {
  // Sandboxed HOME: no whisper-cli, no models, no capture binary → ok=false.
  const r = runCli(["setup"]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout, /Some checks failed/);
});

test("meet finalize --background on a nonexistent dir exits 1 without spawning (P2-7)", () => {
  const r = runCli(["finalize", "/nonexistent/meet-session-xyz", "--background"]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /No session found/);
  assert.ok(!/Background finalizer started/.test(r.stdout + r.stderr), "must not print the started line");
});

test("handleActionError prints one line and sets exitCode; CommanderError re-throws (P2-7)", () => {
  const savedExit = process.exitCode;
  const errors: string[] = [];
  const savedError = console.error;
  console.error = (...parts: unknown[]) => {
    errors.push(parts.map(String).join(" "));
  };
  try {
    handleActionError(new Error("boom: something expected"));
    assert.equal(process.exitCode, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /boom: something expected/);
    assert.ok(!errors[0].includes("    at "), "no stack trace in the error line");
  } finally {
    console.error = savedError;
    process.exitCode = savedExit;
  }
  assert.throws(() => handleActionError(new CommanderError(2, "commander.invalidOption", "error: unknown option")), CommanderError);
});

// P3 row 14 (SPEC_SAFETY_NET_2026-10-31 §7): the README's CLI table must
// match createProgram()'s registered top-level commands — docs drift
// historically shipped removed/renamed commands (ask, --allow-degraded).
test("README CLI table matches createProgram() commands (P3 row 14)", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf-8");
  const m = /<!-- CLI:COMMANDS -->\n[\s\S]*?<!-- \/CLI:COMMANDS -->/.exec(readme);
  assert.ok(m, "README must contain the <!-- CLI:COMMANDS --> markers");
  const block = m[0];
  const readmeCommands = new Set<string>();
  for (const line of block.split("\n")) {
    const match = /^meet ([\w-]+)/.exec(line.trim());
    if (match) readmeCommands.add(match[1]);
  }
  assert.ok(readmeCommands.size > 0, "README table parsed empty");

  const program = createProgram();
  const registered = new Set(program.commands.map((c) => c.name()));

  const missingFromReadme = [...registered].filter((c) => !readmeCommands.has(c));
  const unknownInReadme = [...readmeCommands].filter((c) => !registered.has(c));
  assert.deepEqual(
    { missingFromReadme, unknownInReadme },
    { missingFromReadme: [], unknownInReadme: [] },
    "README CLI table and createProgram() commands must agree",
  );
});

// P3 row 18 (SPEC_SAFETY_NET_2026-10-31 §7): --attendees flows as an array
// end-to-end — the menu bar sends one occurrence per name so "Doe, John"
// survives; a single occurrence stays comma-split for the legacy manual form.
test("resolveAttendees: multi-occurrence trusted, single occurrence comma-split (P3 row 18)", () => {
  assert.deepEqual(resolveAttendees(["A", "Doe, John"]), ["A", "Doe, John"]);
  assert.deepEqual(resolveAttendees(["A,B"]), ["A", "B"]);
  assert.deepEqual(resolveAttendees([" A , B "]), ["A", "B"]);
  assert.deepEqual(resolveAttendees(["A", "Doe, John", ""]), ["A", "Doe, John"]);
  assert.strictEqual(resolveAttendees(undefined), undefined);
  assert.deepEqual(resolveAttendees(["," ]), []);
});

test("--attendees occurrences collect into an array (P3 row 18)", async () => {
  const program = createProgram();
  let captured: Record<string, unknown> | null = null;
  const start = program.commands.find((c) => c.name() === "start");
  assert.ok(start, "start command exists");
  start!.action(async (_title: string, opts: Record<string, unknown>) => {
    captured = opts;
  });
  await program.parseAsync(["start", "--attendees", "A", "--attendees", "Doe, John"], { from: "user" });
  assert.ok(captured);
  assert.deepEqual((captured as Record<string, unknown>).attendees, ["A", "Doe, John"]);
});
