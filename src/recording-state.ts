import { resolve } from "node:path";
import type { ActiveRecordingLock } from "./locks.js";
import type { Session } from "./types.js";

export type RecordingState =
  | { kind: "active"; session: Session; lock: ActiveRecordingLock }
  | { kind: "orphan"; session: Session; capturePid: number }
  | { kind: "stale"; session: Session };

export function classifyRecordingSessions(
  sessions: Session[],
  lock: ActiveRecordingLock | null,
  isPidAlive: (pid: number) => boolean,
): RecordingState[] {
  return sessions
    .filter((session) => session.status !== "done")
    .map((session) => {
      // "paused" covers both a paused live recording (togglePause — capture
      // process stays alive, still owns the active lock) and a session
      // waiting mid-finalization (waitForInactiveRecording/waitForGlobalFinalPassSlot).
      // Both must be checked here or a paused recording whose controller dies
      // is silently classified "stale", missed as an orphan by `meet start`.
      const isRecordingOrPaused = session.status === "recording" || session.status === "paused";
      if (isRecordingOrPaused && lock && resolve(lock.sessionDir) === resolve(session.sessionDir)) {
        return { kind: "active", session, lock } as RecordingState;
      }
      if (isRecordingOrPaused && Number.isSafeInteger(session.capturePid) && session.capturePid! > 0 && isPidAlive(session.capturePid!)) {
        return { kind: "orphan", session, capturePid: session.capturePid! } as RecordingState;
      }
      return { kind: "stale", session } as RecordingState;
    });
}
