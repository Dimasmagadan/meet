import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireFinalizerLock, releaseFinalizerLock, isPidAlive, readFinalizerLock } from "./locks.js";

describe("isPidAlive", () => {
  it("returns true for current process", () => {
    assert.strictEqual(isPidAlive(process.pid), true);
  });

  it("returns false for PID 99999999", () => {
    assert.strictEqual(isPidAlive(99999999), false);
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
