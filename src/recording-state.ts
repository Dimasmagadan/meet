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
      // "paused" is the user's pause (togglePause — the capture process stays
      // alive and still owns the active lock). A finalize pass held back by an
      // active recording uses the distinct "waiting" status, so this no longer
      // needs to guess whether a "paused" session is live or mid-finalize.
      const isLive = session.status === "recording" || session.status === "paused";
      if (isLive && lock && resolve(lock.sessionDir) === resolve(session.sessionDir)) {
        return { kind: "active", session, lock } as RecordingState;
      }
      if (isLive && Number.isSafeInteger(session.capturePid) && session.capturePid! > 0 && isPidAlive(session.capturePid!)) {
        return { kind: "orphan", session, capturePid: session.capturePid! } as RecordingState;
      }
      return { kind: "stale", session } as RecordingState;
    });
}
