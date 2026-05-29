import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "./types.js";

const ACTIVE_LOCK = "/tmp/meet-active-recording.lock";

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeActiveRecordingLock(session: Session): void {
  writeFileSync(ACTIVE_LOCK, JSON.stringify({
    pid: process.pid,
    sessionDir: session.sessionDir,
    title: session.title,
    startedAt: session.startedAt,
    updatedAt: new Date().toISOString(),
  }), "utf-8");
}

export function clearActiveRecordingLock(): void {
  try { unlinkSync(ACTIVE_LOCK); } catch {}
}

export interface ActiveRecordingLock {
  pid: number;
  sessionDir: string;
  title: string;
  startedAt: string;
  updatedAt: string;
}

export function readActiveRecordingLock(): ActiveRecordingLock | null {
  if (!existsSync(ACTIVE_LOCK)) return null;
  try {
    const data = JSON.parse(readFileSync(ACTIVE_LOCK, "utf-8")) as ActiveRecordingLock;
    if (data.pid && isPidAlive(data.pid)) return data;
    try { unlinkSync(ACTIVE_LOCK); } catch {}
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

export function acquireFinalizerLock(sessionDir: string): boolean {
  const lockPath = finalizerLockPath(sessionDir);
  if (existsSync(lockPath)) {
    try {
      const existing = JSON.parse(readFileSync(lockPath, "utf-8")) as FinalizerLock;
      if (existing.pid && isPidAlive(existing.pid)) return false;
    } catch {}
  }
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }), "utf-8");
  return true;
}

export function releaseFinalizerLock(sessionDir: string): void {
  try { unlinkSync(finalizerLockPath(sessionDir)); } catch {}
}

export function readFinalizerLock(sessionDir: string): FinalizerLock | null {
  const lockPath = finalizerLockPath(sessionDir);
  if (!existsSync(lockPath)) return null;
  try {
    const data = JSON.parse(readFileSync(lockPath, "utf-8")) as FinalizerLock;
    if (data.pid && isPidAlive(data.pid)) return data;
    try { unlinkSync(lockPath); } catch {}
    return null;
  } catch {
    return null;
  }
}
