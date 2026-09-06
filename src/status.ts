import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Session } from "./types.js";
import { readActiveRecordingLock, readFinalizerLock } from "./locks.js";
import { findRecordingStates, getSessionsDir } from "./storage.js";

export function showStatus(): void {
  let found = false;

  const activeLock = readActiveRecordingLock();
  if (activeLock) {
    found = true;
    const elapsed = Math.floor((Date.now() - new Date(activeLock.startedAt).getTime()) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    console.log(chalk.cyan("Recording:"));
    console.log(`  ${activeLock.sessionDir}  ${activeLock.title}  ${mins}:${secs} elapsed`);
    console.log();
  }

  const sessions = findSessions();
  const recordingStates = findRecordingStates();
  const orphaned = recordingStates.filter((state) => state.kind === "orphan");

  const activeFinalizers = sessions.filter(
    (s) => (s.status === "finalizing" || s.status === "paused") && readFinalizerLock(s.sessionDir) !== null
  );
  const queued = sessions.filter(
    (s) => s.status === "queued" || ((s.status === "finalizing" || s.status === "paused") && readFinalizerLock(s.sessionDir) === null)
  );
  const errors = sessions.filter((s) => s.status === "error");
  const stopped = sessions.filter((s) => s.status === "stopped");

  // Sessions still marked "recording"/"paused" with a dead controller and no
  // live capture PID (findRecordingStates' "stale" bucket) were previously
  // invisible in every list below — none of the other buckets' filters match
  // status "recording". Exclude dirs already shown elsewhere (a
  // finalization-paused session can also land in "stale" here).
  const shownDirs = new Set([
    ...activeFinalizers.map((s) => s.sessionDir),
    ...queued.map((s) => s.sessionDir),
    ...errors.map((s) => s.sessionDir),
    ...stopped.map((s) => s.sessionDir),
  ]);
  const crashedRecordings = recordingStates.filter(
    (state) => state.kind === "stale" && !shownDirs.has(state.session.sessionDir)
  );

  if (orphaned.length > 0) {
    found = true;
    console.log(chalk.red("Orphaned capture:"));
    for (const state of orphaned) {
      console.log(`  ${state.session.sessionDir}  ${state.session.title}  (capture pid ${state.capturePid})`);
      console.log(chalk.gray(`    Stop the capture manually, then: meet finalize ${state.session.sessionDir}`));
    }
    console.log();
  }

  if (crashedRecordings.length > 0) {
    found = true;
    console.log(chalk.red("Crashed recording:"));
    for (const state of crashedRecordings) {
      console.log(`  ${state.session.sessionDir}  ${state.session.title}`);
      console.log(chalk.gray(`    Recover: meet finalize ${state.session.sessionDir}`));
    }
    console.log();
  }

  if (activeFinalizers.length > 0) {
    found = true;
    console.log(chalk.cyan("Finalizing:"));
    for (const s of activeFinalizers) {
      const lock = readFinalizerLock(s.sessionDir);
      const lockStr = lock ? chalk.green(` (pid ${lock.pid})`) : "";
      const progress = s.finalize;
      let progressStr = "";
      if (progress) {
        const phaseStr = progress.phase === "paused"
          ? chalk.yellow("paused")
          : progress.phase;
        progressStr = `  ${phaseStr} ${progress.done}/${progress.total}`;
        if (progress.message) progressStr += `  ${progress.message}`;
      }
      console.log(`  ${s.sessionDir}  ${s.title}${lockStr}${progressStr}`);
    }
    console.log();
  }

  if (queued.length > 0) {
    found = true;
    console.log(chalk.yellow("Queued / stalled:"));
    for (const s of queued) {
      const statusStr = s.status === "queued" ? "queued" : `${s.status} (no finalizer)`;
      console.log(`  ${s.sessionDir}  ${s.title}  ${chalk.gray(statusStr)}`);
      console.log(chalk.gray(`    Recover: meet finalize ${s.sessionDir}`));
    }
    console.log();
  }

  if (stopped.length > 0) {
    found = true;
    console.log(chalk.yellow("Stopped:"));
    for (const s of stopped) {
      console.log(`  ${s.sessionDir}  ${s.title}`);
      console.log(chalk.gray(`    Recover: meet finalize ${s.sessionDir}`));
    }
    console.log();
  }

  if (errors.length > 0) {
    found = true;
    console.log(chalk.red("Errors:"));
    for (const s of errors) {
      console.log(`  ${s.sessionDir}  ${s.title}`);
      if (s.lastError) console.log(chalk.gray(`    ${s.lastError}`));
      console.log(chalk.gray(`    Recover: meet finalize ${s.sessionDir}`));
    }
    console.log();
  }

  if (!found) {
    console.log("No active recording or finalization jobs.");
  }
}

function findSessions(): Session[] {
  const sessionsDir = getSessionsDir();
  const sessions: Session[] = [];
  try {
    const entries = readdirSync(sessionsDir);
    for (const e of entries) {
      if (!e.startsWith("meet-")) continue;
      const sessionPath = join(sessionsDir, e, "session.json");
      if (!existsSync(sessionPath)) continue;
      try {
        const s = JSON.parse(readFileSync(sessionPath, "utf-8")) as Session;
        if (s.sessionDir) sessions.push(s);
      } catch {}
    }
  } catch {}
  return sessions;
}
