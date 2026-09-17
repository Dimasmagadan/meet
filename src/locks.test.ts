import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireFinalizerLock, releaseFinalizerLock, isPidAlive, readFinalizerLock, acquireRegistryLock, releaseRegistryLock, releaseAllRegistryLocks } from "./locks.js";
import { getSessionsDir } from "./storage.js";

describe("isPidAlive", () => {
  it("returns true for current process", () => {
    assert.strictEqual(isPidAlive(process.pid), true);
  });

  it("returns false for PID 99999999", () => {
    assert.strictEqual(isPidAlive(99999999), false);
  });

  it("confirms the process identity when the comm matches (B9)", () => {
    // This test process runs as node, so a node identity must confirm.
    assert.strictEqual(isPidAlive(process.pid, { comm: "node" }), true);
  });

  it("rejects a live PID whose command does not match (B9)", () => {
    // PID reuse can make a stale lock's PID name an unrelated app; a
    // mismatched comm must not be treated as the owner.
    assert.strictEqual(isPidAlive(process.pid, { comm: "definitely-not-a-real-binary" }), false);
  });

  it("treats a dead PID as dead regardless of the identity requested", () => {
    assert.strictEqual(isPidAlive(99999999, { comm: "node" }), false);
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
  afterEach(() => {
    // A leaked registry lock (or a leaked nesting level) would block every
    // later test that touches the registry, so drain the whole depth.
    releaseAllRegistryLocks();
  });

  it("acquires when no lock exists", () => {
    assert.strictEqual(acquireRegistryLock("test"), true);
  });

  it("is re-entrant: a second acquire from the same process succeeds", () => {
    assert.strictEqual(acquireRegistryLock("test-a"), true);
    assert.strictEqual(acquireRegistryLock("test-b"), true);
  });

  it("nested release does not unlink the lock while the outer hold continues", () => {
    const lockPath = join(getSessionsDir(), "registry.lock");
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
    const lockPath = join(getSessionsDir(), "registry.lock");
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
    const lockPath = join(getSessionsDir(), "registry.lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 99999999, reason: "crashed rename", startedAt: new Date().toISOString() }),
      "utf-8",
    );
    assert.strictEqual(acquireRegistryLock("after-crash"), true);
  });
});
