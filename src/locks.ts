import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync, linkSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Session } from "./types.js";

function sessionsDir(): string {
  const dir = join(homedir(), ".meet", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function activeLockPath(): string {
  return join(sessionsDir(), "active-recording.lock");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function activeLockData(session: Session): string {
  return JSON.stringify({
    pid: process.pid,
    sessionDir: session.sessionDir,
    outputFile: session.outputFile,
    title: session.title,
    startedAt: session.startedAt,
    updatedAt: new Date().toISOString(),
    attendees: session.attendees ?? [],
  });
}

// Refreshes an already-owned lock (e.g. after a retitle changes outputFile).
// Not for acquiring a new lock — use acquireActiveRecordingLock for that.
export function writeActiveRecordingLock(session: Session): void {
  const lockPath = activeLockPath();
  const existing = readActiveRecordingLock();
  if (!existing || existing.pid !== process.pid) throw new Error("Active recording lock is not owned by this process");
  const tmp = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, activeLockData(session), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, lockPath);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// Exclusive create (`wx`) closes the check-then-write race between
// isActiveRecording() and writing the lock: two concurrent `meet start`
// calls can no longer both pass the check and both spawn capture. A lock
// left by a dead PID is stale — readActiveRecordingLock() clears it as a
// side effect, so one retry after that reclaims it.
export function acquireActiveRecordingLock(session: Session): boolean {
  const lockPath = activeLockPath();
  const data = activeLockData(session);

  const tryCreate = (): boolean => {
    const tmp = `${lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
      linkSync(tmp, lockPath);
      return true;
    } catch {
      return false;
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  };

  if (tryCreate()) return true;
  if (readActiveRecordingLock() !== null) return false;
  return tryCreate();
}

// Only the owning PID may release the lock, so a process can't clear a lock
// acquired by a different concurrent recording it lost the race against.
export function clearActiveRecordingLock(): void {
  const existing = readActiveRecordingLock();
  if (existing && existing.pid !== process.pid) return;
  try { unlinkSync(activeLockPath()); } catch {}
}

export interface ActiveRecordingLock {
  pid: number;
  sessionDir: string;
  outputFile: string;
  title: string;
  startedAt: string;
  updatedAt: string;
  attendees?: string[];
}

export function readActiveRecordingLock(): ActiveRecordingLock | null {
  const lockPath = activeLockPath();
  if (!existsSync(lockPath)) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const data = JSON.parse(readFileSync(lockPath, "utf-8")) as ActiveRecordingLock;
      if (Number.isSafeInteger(data.pid) && data.pid > 0 && isPidAlive(data.pid)) return data;
      break;
    } catch {
      if (attempt === 0) continue;
    }
  }
  // New writers only publish complete JSON. Anything malformed here is legacy
  // or corrupt metadata and cannot identify a live owner.
  try { unlinkSync(lockPath); } catch {}
  return null;
}

export function isActiveRecording(): boolean {
  return readActiveRecordingLock() !== null;
}

export interface FinalizerLock {
  pid: number;
  token?: string;
  startedAt: string;
  updatedAt: string;
}

const finalizerLockTokens = new Map<string, string>();
let globalFinalPassToken: string | null = null;

function finalizerLockPath(sessionDir: string): string {
  return join(sessionDir, "finalizer.lock");
}

function cleanStaleLock(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch {
    return !existsSync(lockPath);
  }
  try {
    const existing = JSON.parse(raw) as FinalizerLock;
    if (existing.pid && isPidAlive(existing.pid)) return false;
  } catch {}
  // The failed publisher may have raced a stale-owner reclaimer. Only remove
  // the exact descriptor observed above; a newly published lock has a unique
  // token and different bytes, so it remains owned by its publisher.
  try {
    if (readFileSync(lockPath, "utf-8") !== raw) return false;
  } catch {
    return false;
  }
  try { unlinkSync(lockPath); } catch {}
  return true;
}

// Exclusive create + rename-in (like acquireActiveRecordingLock) so readers
// never observe an empty/partial file between open and metadata write — a
// reader that hit that window previously treated the file as corrupt and
// deleted it, letting a second acquirer in while the first still holds it.
function publishLockAtomically(lockPath: string, data: string): boolean {
  const tmp = `${lockPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, data, "utf-8");
    linkSync(tmp, lockPath);
    return true;
  } catch {
    return false;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

export function acquireFinalizerLock(sessionDir: string): boolean {
  const lockPath = finalizerLockPath(sessionDir);
  const token = randomUUID();
  const lockData = JSON.stringify({
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  if (publishLockAtomically(lockPath, lockData)) {
    finalizerLockTokens.set(sessionDir, token);
    return true;
  }
  if (!cleanStaleLock(lockPath)) return false;
  if (!publishLockAtomically(lockPath, lockData)) return false;
  finalizerLockTokens.set(sessionDir, token);
  return true;
}

export function releaseFinalizerLock(sessionDir: string): void {
  // Conditional on ownership like the global lock below: an unconditional
  // unlink could remove a *different* finalizer's lock if this process lost
  // (or never won) the race and still ran its finally block.
  try {
    const raw = readFileSync(finalizerLockPath(sessionDir), "utf-8");
    const existing = JSON.parse(raw) as FinalizerLock;
    if (existing.pid !== process.pid || existing.token !== finalizerLockTokens.get(sessionDir)) return;
  } catch {
    return;
  }
  try { unlinkSync(finalizerLockPath(sessionDir)); } catch {}
  finalizerLockTokens.delete(sessionDir);
}

// Global lock: only one big-model final pass runs at a time across all sessions.
// Live drains stay unlocked (cheap); this serializes the heavy whisper-cli pass.
export interface GlobalFinalPassLock {
  pid: number;
  token?: string;
  sessionDir: string;
  startedAt: string;
}

function globalFinalPassLockPath(): string {
  return join(sessionsDir(), "final-pass.lock");
}

export function acquireGlobalFinalPassLock(sessionDir: string): boolean {
  const lockPath = globalFinalPassLockPath();
  const token = randomUUID();
  const lockData = JSON.stringify({
    pid: process.pid,
    token,
    sessionDir,
    startedAt: new Date().toISOString(),
  });

  if (publishLockAtomically(lockPath, lockData)) {
    globalFinalPassToken = token;
    return true;
  }

  // Re-entrant: if we already hold it, treat as acquired.
  const existing = readGlobalFinalPassLock();
  if (existing?.pid === process.pid && existing.token === globalFinalPassToken) return true;
  if (existing) return false;

  // Held by a dead PID; reclaim only the exact descriptor observed, then retry.
  if (!cleanStaleLock(lockPath) || !publishLockAtomically(lockPath, lockData)) return false;
  globalFinalPassToken = token;
  return true;
}

export function readGlobalFinalPassLock(): GlobalFinalPassLock | null {
  const lockPath = globalFinalPassLockPath();
  if (!existsSync(lockPath)) return null;
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf-8")) as GlobalFinalPassLock;
    if (data.pid && isPidAlive(data.pid)) return data;
  } catch {}
  cleanStaleLock(lockPath);
  return null;
}

export function releaseGlobalFinalPassLock(): void {
  const existing = readGlobalFinalPassLock();
  if (!existing || existing.pid !== process.pid || existing.token !== globalFinalPassToken) return;
  try { unlinkSync(globalFinalPassLockPath()); } catch {}
  globalFinalPassToken = null;
}

export function readFinalizerLock(sessionDir: string): FinalizerLock | null {
  const lockPath = finalizerLockPath(sessionDir);
  if (!existsSync(lockPath)) return null;
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf-8")) as FinalizerLock;
    if (data.pid && isPidAlive(data.pid)) return data;
  } catch {}
  cleanStaleLock(lockPath);
  return null;
}
