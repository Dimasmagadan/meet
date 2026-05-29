import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import type { Session } from "./types.js";
import { readActiveRecordingLock, readFinalizerLock } from "./locks.js";

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

  const activeFinalizers = sessions.filter(
    (s) => (s.status === "finalizing" || s.status === "paused") && readFinalizerLock(s.sessionDir) !== null
  );
  const queued = sessions.filter(
    (s) => s.status === "queued" || ((s.status === "finalizing" || s.status === "paused") && readFinalizerLock(s.sessionDir) === null)
  );
  const errors = sessions.filter((s) => s.status === "error");
  const stopped = sessions.filter((s) => s.status === "stopped");

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
  const tmpDir = "/tmp";
  const sessions: Session[] = [];
  try {
    const entries = readdirSync(tmpDir);
    for (const e of entries) {
      if (!e.startsWith("meet-")) continue;
      const sessionPath = join(tmpDir, e, "session.json");
      if (!existsSync(sessionPath)) continue;
      try {
        sessions.push(JSON.parse(readFileSync(sessionPath, "utf-8")));
      } catch {}
    }
  } catch {}
  return sessions;
}
