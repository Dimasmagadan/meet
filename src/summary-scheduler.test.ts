import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SummaryScheduler } from "./summary.js";
import type { Session, TranscriptEntry } from "./types.js";
import type { ResourcePressure } from "./system-monitor.js";

function makeSession(opts: Partial<Session> = {}): Session {
  return {
    id: "test",
    title: "Test Meeting",
    mode: "full",
    startedAt: "2026-05-13T14:30:00.000Z",
    chunkDurationSeconds: 15,
    sessionDir: "/tmp/meet-test",
    outputFile: "/tmp/Meetings/test/transcript.md",
    capturePid: null,
    status: "recording",
    processedChunks: [],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
    tags: [],
    ...opts,
  };
}

function makeEntries(n: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({
      source: i % 2 === 0 ? "sys" : "mic",
      chunkIndex: i,
      timestamp: `14:30:${String(i * 5).padStart(2, "0")}`,
      text: `Это запись номер ${i} с разными словами для тестовsummary extraction.`,
    });
  }
  return out;
}

function makePressure(over: Partial<ResourcePressure> = {}): ResourcePressure {
  return {
    cpuLoad1min: 1,
    cpuCores: 8,
    freeMemoryMb: 4096,
    whisperRunning: false,
    overloaded: false,
    reason: null,
    ...over,
  };
}

interface TestRig {
  session: Session;
  outputFile: string;
  dir: string;
  entries: TranscriptEntry[];
  pressure: ResourcePressure;
  getEntriesCalls: number;
  getPressureCalls: number;
}

function makeRig(opts: { entries?: TranscriptEntry[]; pressure?: ResourcePressure; intervalChunks?: number; catchupMs?: number; minEntries?: number } = {}): TestRig {
  const dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
  const session = makeSession({ outputFile: join(dir, "transcript.md") });
  const rig: TestRig = {
    session,
    outputFile: join(dir, "summary.md"),
    dir,
    entries: opts.entries ?? makeEntries(0),
    pressure: opts.pressure ?? makePressure(),
    getEntriesCalls: 0,
    getPressureCalls: 0,
  };
  return rig;
}

function makeScheduler(rig: TestRig, opts: { intervalChunks?: number; catchupMs?: number; minEntries?: number } = {}): SummaryScheduler {
  return new SummaryScheduler({
    session: rig.session,
    outputFile: rig.outputFile,
    intervalChunks: opts.intervalChunks ?? 1,
    catchupIntervalMs: opts.catchupMs ?? 5,
    minEntries: opts.minEntries ?? 4,
    topN: 5,
    maxWindowEntries: 200,
    warn: () => {},
    getEntries: () => {
      rig.getEntriesCalls++;
      return rig.entries;
    },
    getPressure: async () => {
      rig.getPressureCalls++;
      return rig.pressure;
    },
  });
}

describe("SummaryScheduler — chunk-driven path", () => {
  let rigs: TestRig[] = [];

  beforeEach(() => { rigs = []; });
  afterEach(() => {
    for (const r of rigs) {
      try { rmSync(r.dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("triggers a run when the counter reaches intervalChunks", async () => {
    const rig = makeRig({ entries: makeEntries(8), pressure: makePressure() });
    rigs.push(rig);
    const sched = makeScheduler(rig, { intervalChunks: 3 });

    sched.onChunk("mic", 1);
    sched.onChunk("mic", 2);
    // Should NOT have run yet — only 2 chunks, interval is 3.
    assert.strictEqual(existsSync(rig.outputFile), false);
    sched.onChunk("mic", 3);
    // Await the scheduler's in-flight run instead of a fixed timeout.
    await sched.awaitIdle();

    assert.strictEqual(rig.getEntriesCalls, 1);
    assert.strictEqual(sched.isDisabled(), false);
    assert.strictEqual(existsSync(rig.outputFile), true);
  });

  it("coalesces overlapping runs — no second getEntries while one is in flight", async () => {
    const rig = makeRig({ entries: makeEntries(8) });
    rigs.push(rig);
    let resolvePressure: () => void = () => {};
    rig.pressure = makePressure();
    const slowScheduler = new SummaryScheduler({
      session: rig.session,
      outputFile: rig.outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 4,
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => {
        rig.getEntriesCalls++;
        return rig.entries;
      },
      getPressure: () => {
        rig.getPressureCalls++;
        return new Promise<ResourcePressure>((resolve) => {
          resolvePressure = () => resolve(makePressure());
        });
      },
    });

    slowScheduler.onChunk("mic", 1); // starts an in-flight run
    // While in-flight, fire more chunks.
    slowScheduler.onChunk("mic", 2);
    slowScheduler.onChunk("mic", 3);
    slowScheduler.onChunk("mic", 4);
    await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(rig.getEntriesCalls, 0); // not called yet, pressure pending
    resolvePressure();
    await new Promise((r) => setTimeout(r, 10));

    // Only ONE getEntries call should have happened (the in-flight run).
    assert.strictEqual(rig.getEntriesCalls, 1);
  });
});

describe("SummaryScheduler — empty-window early-out", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      dir = null;
    }
  });

  it("does NOT write summary.md when entries < minEntries", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 50, // far above what we feed
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => makeEntries(3),
      getPressure: async () => makePressure(),
    });
    sched.onChunk("mic", 1);
    await sched.awaitIdle();
    assert.strictEqual(existsSync(outputFile), false);
  });
});

describe("SummaryScheduler — timer-driven catch-up", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      dir = null;
    }
  });

  it("retries after overload clears", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    const entries = makeEntries(8);

    let calls = 0;
    let pressureState: ResourcePressure = makePressure({ overloaded: true, reason: "cpu 9.0/8c" });
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5, // very short for the test
      minEntries: 4,
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => {
        calls++;
        return entries;
      },
      getPressure: async () => pressureState,
    });

    sched.onChunk("mic", 1);
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(existsSync(outputFile), false); // paused
    // The catch-up timer should be ticking. Clear the overload.
    pressureState = makePressure();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(existsSync(outputFile), true);
  });
});

describe("SummaryScheduler — flush()", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      dir = null;
    }
  });

  it("awaits an in-flight run before its own run", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    const entries = makeEntries(8);

    let resolvePressure: () => void = () => {};
    let pressureCalls = 0;
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 4,
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => entries,
      getPressure: () => {
        pressureCalls++;
        return new Promise<ResourcePressure>((resolve) => {
          resolvePressure = () => resolve(makePressure());
        });
      },
    });

    sched.onChunk("mic", 1);
    await new Promise((r) => setTimeout(r, 5));
    // In-flight run pending. flush() should await it, then run itself.
    const flushP = sched.flush();
    // Allow in-flight to complete.
    await new Promise((r) => setTimeout(r, 5));
    resolvePressure();
    await flushP;

    assert.ok(existsSync(outputFile));
    // pressure called at least once (the in-flight run) and entries used by flush.
    assert.ok(pressureCalls >= 1);
  });

  it("ignores the intervalChunks gate", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    const entries = makeEntries(8);
    let calls = 0;
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 100, // never reaches the counter in this test
      catchupIntervalMs: 5,
      minEntries: 4,
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => {
        calls++;
        return entries;
      },
      getPressure: async () => makePressure(),
    });
    // No onChunk calls — counter is 0.
    await sched.flush();
    assert.strictEqual(existsSync(outputFile), true);
    assert.ok(calls >= 1);
  });

  it("runs even when pressure reports overloaded", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    const entries = makeEntries(8);
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 4,
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => entries,
      getPressure: async () => makePressure({ overloaded: true, reason: "test" }),
    });
    await sched.flush();
    assert.strictEqual(existsSync(outputFile), true);
  });

  it("always resolves — never rejects", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    const entries = makeEntries(8);
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 4,
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => {
        throw new Error("boom");
      },
      getPressure: async () => makePressure(),
    });
    // First onChunk throws → disabled. flush() must not throw.
    sched.onChunk("mic", 1);
    await new Promise((r) => setTimeout(r, 5));
    await sched.flush(); // should resolve, not reject
    assert.ok(true);
  });

  it("respects minEntries on flush too", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 100, // far above
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => makeEntries(3),
      getPressure: async () => makePressure(),
    });
    await sched.flush();
    assert.strictEqual(existsSync(outputFile), false);
  });
});

describe("SummaryScheduler — fail-open", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      dir = null;
    }
  });

  it("sets disabled on error and subsequent onChunk/flush are no-ops", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    let entryCalls = 0;
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 4,
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => {
        entryCalls++;
        throw new Error("kaboom");
      },
      getPressure: async () => makePressure(),
    });
    sched.onChunk("mic", 1);
    await sched.awaitIdle();
    const callsAfterFirst = entryCalls;
    assert.strictEqual(callsAfterFirst, 1);
    // Subsequent onChunk should be a no-op.
    sched.onChunk("mic", 2);
    sched.onChunk("mic", 3);
    await sched.awaitIdle();
    assert.strictEqual(entryCalls, 1);
    // flush should also be a no-op (disabled set).
    await sched.flush();
    assert.strictEqual(entryCalls, 1);
    assert.strictEqual(existsSync(outputFile), false);
  });

  it("writeAtomic failure does not propagate", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    // Use a path inside a non-existent directory to force write to fail.
    const outputFile = join(dir, "no-such-subdir", "summary.md");
    const entries = makeEntries(8);
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 4,
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => entries,
      getPressure: async () => makePressure(),
    });
    // Should NOT throw out of onChunk.
    sched.onChunk("mic", 1);
    await sched.awaitIdle();
    assert.ok(sched.isDisabled());
    // flush after disable resolves cleanly.
    await sched.flush();
  });
});

describe("SummaryScheduler — file content", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      dir = null;
    }
  });

  it("writes a markdown file with key points section", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    const entries = makeEntries(10);
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 4,
      topN: 5,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => entries,
      getPressure: async () => makePressure(),
    });
    sched.onChunk("mic", 1);
    await sched.awaitIdle();
    const content = readFileSync(outputFile, "utf-8");
    assert.match(content, /# Test Meeting — Summary \(draft\)/);
    assert.match(content, /## Key points/);
    assert.match(content, /## Candidate action items/);
    assert.match(content, /## Participants/);
    assert.match(content, /Draft produced locally by extractive summarization\./);
  });

  it("writes atomically — final file is whole", async () => {
    dir = mkdtempSync(join(tmpdir(), "meet-sched-"));
    const session = makeSession({ outputFile: join(dir, "transcript.md") });
    const outputFile = join(dir, "summary.md");
    const entries = makeEntries(15);
    const sched = new SummaryScheduler({
      session,
      outputFile,
      intervalChunks: 1,
      catchupIntervalMs: 5,
      minEntries: 4,
      topN: 3,
      maxWindowEntries: 200,
      warn: () => {},
      getEntries: () => entries,
      getPressure: async () => makePressure(),
    });
    sched.onChunk("mic", 1);
    await sched.awaitIdle();
    const content = readFileSync(outputFile, "utf-8");
    assert.ok(content.startsWith("# "));
    assert.ok(content.endsWith("future spec).\n"));
  });
});
