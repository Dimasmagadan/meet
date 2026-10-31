import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { acquireFinalizerLock, releaseFinalizerLock, isPidAlive, readPidComm, readFinalizerLock, readActiveRecordingLock, acquireRegistryLock, releaseRegistryLock, releaseAllRegistryLocks, setSessionsDirForTest, getLocksSessionsDirForTest } from "./locks.js";

describe("isPidAlive", () => {
  it("returns true for current process", () => {
    assert.strictEqual(isPidAlive(process.pid), true);
  });

  it("returns false for PID 99999999", () => {
    assert.strictEqual(isPidAlive(99999999), false);
  });

  it("confirms the process identity when the comm matches (B9)", () => {
    // The comm must be whatever ps actually reports for this process — on
    // linux that is the main-thread title ("MainThread"), not "node"
    // (CI_LINUX_FINDINGS §2), so a literal "node" here fails off-platform.
    const comm = readPidComm(process.pid);
    if (comm === null) return; // ps unavailable → production fail-opens identically
    assert.strictEqual(isPidAlive(process.pid, { comm }), true);
  });

  it("rejects a live PID whose command does not match (B9)", () => {
    // PID reuse can make a stale lock's PID name an unrelated app; a
    // mismatched comm must not be treated as the owner.
    assert.strictEqual(isPidAlive(process.pid, { comm: "definitely-not-a-real-binary" }), false);
  });

  it("treats a dead PID as dead regardless of the identity requested", () => {
    assert.strictEqual(isPidAlive(99999999, { comm: "node" }), false);
  });

  // CI_LINUX_FINDINGS §2/§7.4.1 regression: the stub-only suites below can't
  // see what the platform's real ps reports (linux answers "MainThread" for a
  // live node process, not "node" — the hardcoded name reclaimed live locks).
  // These probes run the real ps and pin the stored-vs-current round-trip.
  it("real probe: a spawned node child is alive under the comm ps reports for it", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    try {
      // Give the child a moment to exec so comm names it, not the parent.
      await new Promise((r) => setTimeout(r, 150));
      const pid = child.pid;
      if (pid === undefined) return;
      const comm = readPidComm(pid);
      if (comm === null) return; // ps unavailable in this environment → fail-open, like production
      assert.strictEqual(isPidAlive(pid, { comm }), true);
    } finally {
      // A live child keeps this file's event loop drained forever — kill and
      // wait so the runner never stalls on this test.
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
  });

  it("real probe: a lock acquired by this process reads back as live (no hardcoded comm)", () => {
    const dir = join(tmpdir(), `meet-test-lock-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    try {
      // Uses the real ps end to end: acquire stores pidComm/pidStartTime from
      // this process; the reader must classify its own live lock as alive.
      assert.strictEqual(acquireFinalizerLock(dir), true);
      assert.notStrictEqual(readFinalizerLock(dir), null, "a live owner's lock must read back as live");
    } finally {
      releaseFinalizerLock(dir);
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("acquireFinalizerLock", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `meet-test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it("acquires lock when none exists", () => {
    assert.strictEqual(acquireFinalizerLock(testDir), true);
    releaseFinalizerLock(testDir);
  });

  it("prevents duplicate lock acquisition", () => {
    assert.strictEqual(acquireFinalizerLock(testDir), true);
    assert.strictEqual(acquireFinalizerLock(testDir), false);
    releaseFinalizerLock(testDir);
  });

  it("allows re-acquisition after release", () => {
    assert.strictEqual(acquireFinalizerLock(testDir), true);
    releaseFinalizerLock(testDir);
    assert.strictEqual(acquireFinalizerLock(testDir), true);
    releaseFinalizerLock(testDir);
  });

  it("removes invalid JSON lock and acquires", () => {
    writeFileSync(join(testDir, "finalizer.lock"), "not json", "utf-8");
    assert.strictEqual(acquireFinalizerLock(testDir), true);
    releaseFinalizerLock(testDir);
  });

  it("removes stale dead-pid lock and acquires", () => {
    writeFileSync(
      join(testDir, "finalizer.lock"),
      JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      "utf-8"
    );
    assert.strictEqual(acquireFinalizerLock(testDir), true);
    releaseFinalizerLock(testDir);
  });

  // Regression for P1 finding #5: release must be conditional on ownership —
  // an unconditional unlink could remove a *different* finalizer's lock after
  // losing the acquisition race.
  it("releaseFinalizerLock does not remove another owner's lock", () => {
    const lockPath = join(testDir, "finalizer.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      "utf-8"
    );
    releaseFinalizerLock(testDir);
    assert.strictEqual(existsSync(lockPath), true);
  });
});

describe("readFinalizerLock", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `meet-test-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it("returns active lock when pid is alive", () => {
    assert.strictEqual(acquireFinalizerLock(testDir), true);
    const lock = readFinalizerLock(testDir);
    assert.ok(lock);
    assert.strictEqual(lock?.pid, process.pid);
    releaseFinalizerLock(testDir);
  });

  it("cleans invalid JSON lock and returns null", () => {
    const lockPath = join(testDir, "finalizer.lock");
    writeFileSync(lockPath, "not json", "utf-8");
    assert.strictEqual(readFinalizerLock(testDir), null);
    assert.strictEqual(existsSync(lockPath), false);
  });

  it("cleans dead-pid lock and returns null", () => {
    const lockPath = join(testDir, "finalizer.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
      "utf-8"
    );
    assert.strictEqual(readFinalizerLock(testDir), null);
    assert.strictEqual(existsSync(lockPath), false);
  });
});

describe("acquireRegistryLock", () => {
  let testSessionsDir: string;

  beforeEach(() => {
    // N8: this suite used to write fake lock owners straight over the real
    // ~/.meet/sessions/registry.lock — running it while a real finalizer or
    // `meet rename` held that lock would clobber a live process's lock.
    testSessionsDir = join(tmpdir(), `meet-test-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testSessionsDir, { recursive: true });
    setSessionsDirForTest(testSessionsDir);
  });

  afterEach(() => {
    // A leaked registry lock (or a leaked nesting level) would block every
    // later test that touches the registry, so drain the whole depth.
    releaseAllRegistryLocks();
    setSessionsDirForTest(null);
    try { rmSync(testSessionsDir, { recursive: true, force: true }); } catch {}
  });

  it("acquires when no lock exists", () => {
    assert.strictEqual(acquireRegistryLock("test"), true);
  });

  it("is re-entrant: a second acquire from the same process succeeds", () => {
    assert.strictEqual(acquireRegistryLock("test-a"), true);
    assert.strictEqual(acquireRegistryLock("test-b"), true);
  });

  it("nested release does not unlink the lock while the outer hold continues", () => {
    const lockPath = join(getLocksSessionsDirForTest(), "registry.lock");
    assert.strictEqual(acquireRegistryLock("outer"), true);
    assert.strictEqual(acquireRegistryLock("inner"), true);
    releaseRegistryLock(); // inner
    // Outer still holds it — the file must still name us and re-acquire stays true.
    assert.ok(existsSync(lockPath), "nested release unlinked the outer holder's lock");
    assert.strictEqual(acquireRegistryLock("inner-2"), true);
  });

  it("release without a successful acquire is a no-op", () => {
    // finalize.ts' registry steps call releaseRegistryLock() from a finally
    // even when the acquire returned false — that must not drop another
    // process's lock.
    const lockPath = join(getLocksSessionsDirForTest(), "registry.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999998, token: "someone-else", reason: "concurrent rename", startedAt: new Date().toISOString() }),
      "utf-8",
    );
    releaseRegistryLock();
    const held = readFileSync(lockPath, "utf-8");
    assert.ok(held.includes("someone-else"), "release dropped a lock we never acquired");
  });

  it("reclaiming a stale lock from a dead pid succeeds", () => {
    // Simulate a holder that died without releasing (kill -9 during a rename).
    const lockPath = join(getLocksSessionsDirForTest(), "registry.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, reason: "crashed rename", startedAt: new Date().toISOString() }),
      "utf-8",
    );
    assert.strictEqual(acquireRegistryLock("after-crash"), true);
  });

  // Regression for N8: releaseRegistryLock used to return early (without
  // resetting registryLockDepth to 0) when depth === 1 and the lock file was
  // gone or unreadable, which made releaseAllRegistryLocks' while-loop spin
  // forever. Deleting the file out from under an active hold reproduces it.
  it("releaseRegistryLock resets depth instead of looping when the lock file is gone", () => {
    assert.strictEqual(acquireRegistryLock("vanishing"), true);
    const lockPath = join(getLocksSessionsDirForTest(), "registry.lock");
    rmSync(lockPath, { force: true });
    releaseRegistryLock();
    // If depth weren't reset, this call would hang forever.
    releaseAllRegistryLocks();
    assert.strictEqual(acquireRegistryLock("after-vanish"), true);
  });

  it("releaseRegistryLock resets depth instead of looping when another owner holds the file", () => {
    assert.strictEqual(acquireRegistryLock("stolen"), true);
    const lockPath = join(getLocksSessionsDirForTest(), "registry.lock");
    // A different (dead) pid/token now on disk — as if our descriptor got
    // reclaimed and republished out from under us. releaseRegistryLock must
    // not unlink someone else's lock, but it also must not get stuck at
    // depth 1 forever just because it isn't the owner any more.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999998, token: "not-ours", reason: "someone else", startedAt: new Date().toISOString() }),
      "utf-8",
    );
    releaseRegistryLock();
    releaseAllRegistryLocks();
    assert.strictEqual(acquireRegistryLock("after-steal"), true);
  });
});

// P3 row 5 (SPEC_SAFETY_NET_2026-10-31 §7): a recycled PID must not make a
// dead owner's lock look live — the lock stores the owner's `ps -o lstart=`
// at acquire and isPidAlive compares it. PATH-stubbed ps keeps the test
// hermetic.
describe("isPidAlive pidStartTime (P3 row 5)", () => {
  let stubDir: string;
  let savedPath: string | undefined;
  let sandboxDir: string;

  beforeEach(() => {
    // N8/CI_LINUX_FINDINGS §7.3.5: this suite hand-writes active-recording
    // locks and the "lock kept" cases deliberately leave them on disk —
    // without the sandbox those bytes land in the real ~/.meet/sessions,
    // where a concurrent `meet start` is refused and `meet status` reports a
    // phantom recording for as long as the suite runs.
    sandboxDir = join(tmpdir(), `meet-test-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(sandboxDir, { recursive: true });
    setSessionsDirForTest(sandboxDir);
  });

  afterEach(() => {
    setSessionsDirForTest(null);
    try { rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
    if (savedPath !== undefined) process.env.PATH = savedPath;
    try { rmSync(stubDir, { recursive: true, force: true }); } catch {}
  });

  const makePsStub = (): void => {
    stubDir = join(tmpdir(), `meet-test-ps-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stubDir, { recursive: true });
    const ps = join(stubDir, "ps");
    // $1=-o  $2=comm=|lstart=  $3=-p  $4=pid — answers come from files the
    // test writes, so each case controls what the "current" process looks like.
    writeFileSync(ps, `#!/bin/sh
if [ "$2" = "lstart=" ]; then
  cat "${join(stubDir, "lstart-answer")}" 2>/dev/null || exit 1
else
  echo "node"
fi
`, { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${stubDir}:${savedPath ?? ""}`;
  };

  const writeLock = (startTime: string): void => {
    writeFileSync(join(getLocksSessionsDirForTest(), "active-recording.lock"), JSON.stringify({
      pid: process.pid,
      pidStartTime: startTime,
      sessionDir: "/tmp/x",
      outputFile: "/tmp/x/transcript.md",
      title: "t",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }), "utf-8");
  };

  it("a stored start time that no longer matches → dead owner (lock reclaimed)", () => {
    makePsStub();
    writeFileSync(join(stubDir, "lstart-answer"), "Tue Feb  2 02:02:02 2022\n");
    writeLock("Mon Jan  1 01:01:01 2001");
    assert.strictEqual(readActiveRecordingLock(), null, "recycled PID must read as dead");
    assert.strictEqual(existsSync(join(getLocksSessionsDirForTest(), "active-recording.lock")), false, "stale lock must be cleared");
  });

  it("a matching start time → alive (lock kept)", () => {
    makePsStub();
    writeFileSync(join(stubDir, "lstart-answer"), "Mon Jan  1 01:01:01 2001\n");
    writeLock("Mon Jan  1 01:01:01 2001");
    assert.notStrictEqual(readActiveRecordingLock(), null);
  });

  it("ps failure stays fail-open (lock kept, never orphan a real owner)", () => {
    makePsStub();
    // No lstart-answer file → the stub exits 1 → readPidStartTime null.
    writeLock("Mon Jan  1 01:01:01 2001");
    assert.notStrictEqual(readActiveRecordingLock(), null);
  });
});
