import { writeFileSync, existsSync, readFileSync, unlinkSync, openSync, closeSync, mkdirSync, linkSync, renameSync } from "node:fs";
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
  startedAt: string;
  updatedAt: string;
}

function finalizerLockPath(sessionDir: string): string {
  return join(sessionDir, "finalizer.lock");
}

function cleanStaleLock(lockPath: string): boolean {
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const existing = JSON.parse(raw) as FinalizerLock;
    if (existing.pid && isPidAlive(existing.pid)) return false;
  } catch {}
  try { unlinkSync(lockPath); } catch {}
  return true;
}

export function acquireFinalizerLock(sessionDir: string): boolean {
  const lockPath = finalizerLockPath(sessionDir);
  const lockData = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, lockData, "utf-8");
    closeSync(fd);
    return true;
  } catch {
    if (!cleanStaleLock(lockPath)) return false;
  }

  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, lockData, "utf-8");
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export function releaseFinalizerLock(sessionDir: string): void {
  try { unlinkSync(finalizerLockPath(sessionDir)); } catch {}
}

// Global lock: only one big-model final pass runs at a time across all sessions.
// Live drains stay unlocked (cheap); this serializes the heavy whisper-cli pass.
export interface GlobalFinalPassLock {
  pid: number;
  sessionDir: string;
  startedAt: string;
}

function globalFinalPassLockPath(): string {
  return join(sessionsDir(), "final-pass.lock");
}

export function acquireGlobalFinalPassLock(sessionDir: string): boolean {
  const lockPath = globalFinalPassLockPath();
  const lockData = JSON.stringify({
    pid: process.pid,
    sessionDir,
    startedAt: new Date().toISOString(),
  });

  const tryOpen = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(fd, lockData, "utf-8");
      closeSync(fd);
      return true;
    } catch {
      return false;
    }
  };

  if (tryOpen()) return true;

  // Re-entrant: if we already hold it, treat as acquired.
  const existing = readGlobalFinalPassLock();
  if (existing?.pid === process.pid) return true;
  if (existing) return false;

  // Held by a dead PID and cleaned by readGlobalFinalPassLock(); retry once.
  return tryOpen();
}

export function readGlobalFinalPassLock(): GlobalFinalPassLock | null {
  const lockPath = globalFinalPassLockPath();
  if (!existsSync(lockPath)) return null;
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf-8")) as GlobalFinalPassLock;
    if (data.pid && isPidAlive(data.pid)) return data;
  } catch {}
  try { unlinkSync(lockPath); } catch {}
  return null;
}

export function releaseGlobalFinalPassLock(): void {
  const existing = readGlobalFinalPassLock();
  if (existing && existing.pid !== process.pid) return;
  try { unlinkSync(globalFinalPassLockPath()); } catch {}
}

export function readFinalizerLock(sessionDir: string): FinalizerLock | null {
  const lockPath = finalizerLockPath(sessionDir);
  if (!existsSync(lockPath)) return null;
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf-8")) as FinalizerLock;
    if (data.pid && isPidAlive(data.pid)) return data;
  } catch {}
  try { unlinkSync(lockPath); } catch {}
  return null;
}
