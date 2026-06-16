import { writeFileSync, existsSync, readFileSync, unlinkSync, openSync, closeSync, mkdirSync } from "node:fs";
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

export function writeActiveRecordingLock(session: Session): void {
  writeFileSync(activeLockPath(), JSON.stringify({
    pid: process.pid,
    sessionDir: session.sessionDir,
    title: session.title,
    startedAt: session.startedAt,
    updatedAt: new Date().toISOString(),
  }), "utf-8");
}

export function clearActiveRecordingLock(): void {
  try { unlinkSync(activeLockPath()); } catch {}
}

export interface ActiveRecordingLock {
  pid: number;
  sessionDir: string;
  title: string;
  startedAt: string;
  updatedAt: string;
}

export function readActiveRecordingLock(): ActiveRecordingLock | null {
  const lockPath = activeLockPath();
  if (!existsSync(lockPath)) return null;
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf-8")) as ActiveRecordingLock;
    if (data.pid && isPidAlive(data.pid)) return data;
    try { unlinkSync(lockPath); } catch {}
    return null;
  } catch {
    return null;
  }
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
