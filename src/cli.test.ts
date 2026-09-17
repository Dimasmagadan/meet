import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { createProgram, parseNonNegativeInteger, parsePositiveInteger } from "./cli.js";

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
