import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { formatLagStatus, planRetitle, readAskMarker } from "./recorder.js";

test("formatLagStatus: up to date when no lag", () => {
  assert.equal(formatLagStatus(0, 15, 8), "up to date");
});

test("formatLagStatus: shows plain lag below warn threshold", () => {
  assert.equal(formatLagStatus(3, 15, 8), "lag ~45s");
});

test("formatLagStatus: warns at/above threshold using the color fn", () => {
  const warned = formatLagStatus(8, 15, 8, (s) => `WARN(${s})`);
  assert.equal(warned, "WARN(lag ~120s (queue backing up))");
});

test("planRetitle: same slug as today is a no-op", () => {
  const result = planRetitle("/Meetings/2026-08-04_10-00-meeting/transcript.md", {
    title: "meeting",
    newOutputDir: "/Meetings/2026-08-04_10-00-meeting",
  });
  assert.equal(result.noop, true);
  assert.equal(result.newOutputFile, "/Meetings/2026-08-04_10-00-meeting/transcript.md");
});

test("planRetitle: new slug moves the folder, keeps the basename", () => {
  const result = planRetitle("/Meetings/2026-08-04_10-00-meeting/transcript.md", {
    title: "Standup",
    newOutputDir: "/Meetings/2026-08-04_10-00-standup",
  });
  assert.equal(result.noop, false);
  assert.equal(result.newOutputFile, "/Meetings/2026-08-04_10-00-standup/transcript.md");
});

test("planRetitle: second rename moves from the already-renamed folder", () => {
  const result = planRetitle("/Meetings/2026-08-04_10-00-standup/transcript.md", {
    title: "Standup 2",
    newOutputDir: "/Meetings/2026-08-04_10-00-standup-2",
  });
  assert.equal(result.noop, false);
  assert.equal(result.newOutputFile, "/Meetings/2026-08-04_10-00-standup-2/transcript.md");
});

// --- readAskMarker (SPEC_NOTCH_TABS_2026-08-12) ---

test("readAskMarker: returns { id, question } for a valid marker", () => {
  const dir = join(tmpdir(), `meet-ask-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "ask-request.json"), JSON.stringify({ id: "abc123", question: "What was discussed?" }), "utf-8");
    const marker = readAskMarker(dir);
    assert.deepEqual(marker, { id: "abc123", question: "What was discussed?" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAskMarker: returns null and deletes when missing id or question", () => {
  const dir = join(tmpdir(), `meet-ask-mid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "ask-request.json"), JSON.stringify({ id: "abc123" }), "utf-8");
    const marker = readAskMarker(dir);
    assert.equal(marker, null);
    assert.equal(existsSync(join(dir, "ask-request.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAskMarker: returns null and deletes for invalid JSON", () => {
  const dir = join(tmpdir(), `meet-ask-bad-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, "ask-request.json"), "not json", "utf-8");
    const marker = readAskMarker(dir);
    assert.equal(marker, null);
    assert.equal(existsSync(join(dir, "ask-request.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAskMarker: returns null when file is absent (does not throw)", () => {
  const dir = join(tmpdir(), `meet-ask-none-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const marker = readAskMarker(dir);
    assert.equal(marker, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- P2-5 (SPEC_SAFETY_NET_2026-10-31 §5.1): capture startup race ----------

import { Recorder } from "./recorder.js";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import type { Session, Config } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { writeAtomic } from "./storage.js";
import { acquireActiveRecordingLock } from "./locks.js";

class FakeCapture extends EventEmitter {
  pid = 424242;
  exitCode: number | null = null;
  killed = false;
  readonly stderr = new EventEmitter();
  kill(): boolean {
    this.killed = true;
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

// Polling helper — generous hang bound only, no tight sleeps (P3 row 13).
async function awaitCondition(fn: () => boolean, timeoutMs = 2000, pollMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("awaitCondition: timed out");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

function makeRecorderSession(sessionDir: string, meetingDir: string): Session {
  return {
    id: "test-recorder",
    title: "Recorder Test",
    mode: "full",
    startedAt: new Date().toISOString(),
    chunkDurationSeconds: 30,
    sessionDir,
    outputFile: join(meetingDir, "transcript.md"),
    capturePid: null,
    status: "recording",
    processedChunks: [],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
    tags: [],
  };
}

// Runs a Recorder against a stub capture with a sandboxed HOME (the active
// recording lock and config live under ~/.meet) and a stubbed process.exit
// (shutdown() ends with process.exit — the test process must survive it).
async function withRecorderHarness(
  child: FakeCapture,
  spawnChild: () => FakeCapture,
  fn: (harness: { sessionDir: string; lockPath: string; exitCalls: number[] }) => Promise<void>,
): Promise<void> {
  const savedHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "meet-recorder-home-"));
  process.env.HOME = tempHome;
  const savedExit = process.exit;
  const exitCalls: number[] = [];
  (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
    exitCalls.push(code ?? 0);
  };
  const sessionDir = mkdtempSync(join(tmpdir(), "meet-recorder-session-"));
  const meetingDir = mkdtempSync(join(tmpdir(), "meet-recorder-meeting-"));
  try {
    const session = makeRecorderSession(sessionDir, meetingDir);
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));
    // cli.ts's startSessionLoop acquires the active lock before constructing
    // the Recorder; writeActiveRecordingLock only refreshes an owned lock.
    assert.equal(acquireActiveRecordingLock(session), true);
    const config: Config = { ...DEFAULT_CONFIG, captureBin: "/nonexistent/AudioCapture" };
    const opts = {
      silenceTimeout: 0,
      maxDurationMinutes: 60,
      noTextTimeoutMinutes: 10,
      voiceProcessing: false,
      headless: true,
      spawnCapture: ((_bin: string, _args: readonly string[]) => spawnChild()) as unknown as typeof spawn,
      captureBinPath: "/nonexistent/AudioCapture",
      spawnFinalizer: () => 12345,
    };
    const recorder = new Recorder(session, config, opts);
    const runPromise = recorder.run();
    await fn({ sessionDir, lockPath: join(tempHome, ".meet", "sessions", "active-recording.lock"), exitCalls });
    await runPromise;
  } finally {
    process.env.HOME = savedHome;
    (process as unknown as { exit: (code?: number) => never }).exit = savedExit;
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(meetingDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
}

test("capture exiting during startCapture triggers shutdown (P2-5)", async () => {
  const child = new FakeCapture();
  const t0 = Date.now();
  await withRecorderHarness(
    child,
    () => {
      // Emit exit while startCapture's session.json/lock writes are in flight.
      setImmediate(() => child.emit("exit", 1));
      return child;
    },
    async ({ lockPath, exitCalls }) => {
      // Pre-fix: neither listener saw the death, run() never settled and the
      // lock stayed. Post-fix: shutdown clears the lock promptly.
      await awaitCondition(() => !existsSync(lockPath), 2000);
      assert.ok(Date.now() - t0 < 5000, "run must settle promptly after the capture dies");
      await awaitCondition(() => exitCalls.length > 0, 2000);
      assert.equal(exitCalls[0], 0);
    },
  );
});

test("capture already-exited state settles run() without any event (P2-5)", async () => {
  const child = new FakeCapture();
  child.exitCode = 1; // spawn-to-listener gap: the child died before listeners attached
  const t0 = Date.now();
  await withRecorderHarness(
    child,
    () => child,
    async ({ lockPath, exitCalls }) => {
      await awaitCondition(() => !existsSync(lockPath), 2000);
      assert.ok(Date.now() - t0 < 5000);
      // Shutdown runs fire-and-forget; wait for its process.exit before the
      // harness deletes the session dir out from under it.
      await awaitCondition(() => exitCalls.length > 0, 2000);
    },
  );
});

// --- P2-6 (SPEC_SAFETY_NET_2026-10-31 §5.2): Ctrl-D at the opencode prompt --
// EOF emits readline's "close" WITHOUT the pending question callback; the
// old inline flow left the opencode guard stuck and the 5s status ticker
// (and with it checkAutoStop) dead for the rest of the session.

import { askOpencode } from "./recorder.js";
import { PassThrough } from "node:stream";

function collectStream(stream: PassThrough): () => string {
  const chunks: string[] = [];
  stream.on("data", (c: Buffer) => chunks.push(String(c)));
  return () => chunks.join("");
}

test("askOpencode: Ctrl-D (EOF) resets the guard and restarts the status ticker", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stdoutText = collectStream(stdout);
  let restarts = 0;
  let questionAsked = false;

  askOpencode({
    stdin,
    stdout,
    isTTY: false,
    setRawMode: () => {},
    runQuestion: async () => {
      questionAsked = true;
      return "never";
    },
    restartStatus: () => {
      restarts++;
    },
  });

  stdin.end(); // Ctrl-D / EOF

  await awaitCondition(() => restarts === 1, 1000);
  assert.equal(questionAsked, false, "the pending question callback must not run on EOF");
  assert.ok(!stdoutText().includes("(cancelled)"), "EOF is not a user cancel");
  // The guard stays reset: a second close-like event must not double-restart.
  stdin.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(restarts, 1, "exactly one restart");
});

test("askOpencode: a submitted answer concludes exactly once and restarts the ticker", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stdoutText = collectStream(stdout);
  let restarts = 0;

  askOpencode({
    stdin,
    stdout,
    isTTY: false,
    setRawMode: () => {},
    runQuestion: async (q) => `answer to ${q}`,
    restartStatus: () => {
      restarts++;
    },
  });

  stdin.write("what is this?\n");
  await awaitCondition(() => stdoutText().includes("--- End answer ---"), 1000);
  assert.ok(stdoutText().includes("answer to what is this?"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(restarts, 1, "the synchronous close from rl.close() must not double-conclude");
});

test("askOpencode: empty line + Enter cancels and restarts the ticker", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stdoutText = collectStream(stdout);
  let restarts = 0;

  askOpencode({
    stdin,
    stdout,
    isTTY: false,
    setRawMode: () => {},
    runQuestion: async () => "never",
    restartStatus: () => {
      restarts++;
    },
  });

  stdin.write("\n");
  await awaitCondition(() => restarts === 1, 1000);
  assert.ok(stdoutText().includes("(cancelled)"));
});

// --- P3 rows 2+3 (SPEC_SAFETY_NET_2026-10-31 §7): cap honesty ----------------

import { formatClock } from "./recorder.js";

test("formatClock rounds fractional seconds (P3 row 3)", () => {
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(59.4), "00:59");
  assert.equal(formatClock(367.4), "06:07");
  assert.equal(formatClock(3600), "60:00");
});

test("extendCap on --max-duration 0 leaves the cap unlimited (P3 row 2)", async () => {
  const savedHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "meet-recorder-home-"));
  process.env.HOME = tempHome;
  const sessionDir = mkdtempSync(join(tmpdir(), "meet-recorder-cap-"));
  const meetingDir = mkdtempSync(join(tmpdir(), "meet-recorder-meeting-"));
  try {
    const session = makeRecorderSession(sessionDir, meetingDir);
    assert.equal(acquireActiveRecordingLock(session), true);
    const config: Config = { ...DEFAULT_CONFIG, captureBin: "/nonexistent/AudioCapture" };
    const recorder = new Recorder(session, config, {
      silenceTimeout: 0,
      maxDurationMinutes: 0,
      noTextTimeoutMinutes: 10,
      voiceProcessing: false,
      headless: true,
      spawnCapture: (() => new FakeCapture()) as unknown as typeof spawn,
      captureBinPath: "/nonexistent/AudioCapture",
      spawnFinalizer: () => 12345,
    });
    // extendCap is private; TS-private is compile-time only.
    (recorder as unknown as { extendCap(): void }).extendCap();
    const opts = (recorder as unknown as { opts: { maxDurationMinutes: number } }).opts;
    assert.equal(opts.maxDurationMinutes, 0, "unlimited cap must stay 0");
  } finally {
    process.env.HOME = savedHome;
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(meetingDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

// P2-5 third variant (SPEC_SAFETY_NET_2026-10-31 §5.1): a real capture binary
// that exits immediately — the spawn-to-listener gap must still settle run().
test("a real capture binary exiting at spawn settles run() (P2-5 fake-binary variant)", async () => {
  const savedHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "meet-recorder-home-"));
  process.env.HOME = tempHome;
  const sessionDir = mkdtempSync(join(tmpdir(), "meet-recorder-fakebin-"));
  const meetingDir = mkdtempSync(join(tmpdir(), "meet-recorder-meeting-"));
  const fakeBin = join(sessionDir, "fake-capture.sh");
  writeFileSync(fakeBin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const savedExit = process.exit;
  const exitCalls: number[] = [];
  (process as unknown as { exit: (code?: number) => void }).exit = (code?: number) => {
    exitCalls.push(code ?? 0);
  };
  const t0 = Date.now();
  try {
    const session = makeRecorderSession(sessionDir, meetingDir);
    assert.equal(acquireActiveRecordingLock(session), true);
    const config: Config = { ...DEFAULT_CONFIG, captureBin: fakeBin };
    const recorder = new Recorder(session, config, {
      silenceTimeout: 0,
      maxDurationMinutes: 60,
      noTextTimeoutMinutes: 10,
      voiceProcessing: false,
      headless: true,
      captureBinPath: fakeBin,
      spawnFinalizer: () => 12345,
    });
    const runPromise = recorder.run();
    const lockPath = join(tempHome, ".meet", "sessions", "active-recording.lock");
    await awaitCondition(() => !existsSync(lockPath), 2000);
    await awaitCondition(() => exitCalls.length > 0, 2000);
    assert.equal(exitCalls[0], 0);
    assert.ok(Date.now() - t0 < 5000, "run must settle promptly after the fake capture dies");
    await runPromise;
  } finally {
    process.env.HOME = savedHome;
    (process as unknown as { exit: (code?: number) => never }).exit = savedExit;
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(meetingDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

// P3 row 20 (SPEC_SAFETY_NET_2026-10-31 §7): the SIGUSR1/USR2 handlers fire
// togglePause fire-and-forget — a rejecting pause path (session.json vanished)
// must hit the .catch, not crash the process as an unhandled rejection.
test("a rejecting togglePause does not crash the process (P3 row 20)", async () => {
  const savedHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "meet-recorder-home-"));
  process.env.HOME = tempHome;
  const sessionDir = mkdtempSync(join(tmpdir(), "meet-recorder-pause-"));
  const meetingDir = mkdtempSync(join(tmpdir(), "meet-recorder-meeting-"));
  const savedExit = process.exit;
  (process as unknown as { exit: (code?: number) => void }).exit = () => {};
  try {
    const session = makeRecorderSession(sessionDir, meetingDir);
    assert.equal(acquireActiveRecordingLock(session), true);
    const config: Config = { ...DEFAULT_CONFIG, captureBin: "/nonexistent/AudioCapture" };
    const recorder = new Recorder(session, config, {
      silenceTimeout: 0,
      maxDurationMinutes: 60,
      noTextTimeoutMinutes: 10,
      voiceProcessing: false,
      headless: true,
      spawnCapture: (() => new FakeCapture()) as unknown as typeof spawn,
      captureBinPath: "/nonexistent/AudioCapture",
      spawnFinalizer: () => 12345,
    });
    // initPipeline wires the handlers; start() would open the watcher — use
    // setupSignalHandlers directly (private, but TS-private is compile-time).
    (recorder as unknown as { setupSignalHandlers(): void }).setupSignalHandlers();
    // Delete the session dir out from under togglePause: its session.json
    // write rejects (ENOENT), which the SIGUSR handler must swallow.
    rmSync(sessionDir, { recursive: true, force: true });
    (recorder as unknown as { sigusr1Handler: () => void }).sigusr1Handler();
    (recorder as unknown as { sigusr2Handler: () => void }).sigusr2Handler();
    // If the rejection were unhandled, Node's default would crash the test
    // runner before this resolves.
    await new Promise((r) => setTimeout(r, 150));
    // setupSignalHandlers started the 5s status interval — stop it or the
    // test-file process never drains and the runner waits forever.
    (recorder as unknown as { stopStatus(): void }).stopStatus();
  } finally {
    process.env.HOME = savedHome;
    (process as unknown as { exit: (code?: number) => never }).exit = savedExit;
    rmSync(sessionDir, { recursive: true, force: true });
    rmSync(meetingDir, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});
