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
      if (session.status === "recording" && lock && resolve(lock.sessionDir) === resolve(session.sessionDir)) {
        return { kind: "active", session, lock } as RecordingState;
      }
      if (session.status === "recording" && Number.isSafeInteger(session.capturePid) && session.capturePid! > 0 && isPidAlive(session.capturePid!)) {
        return { kind: "orphan", session, capturePid: session.capturePid! } as RecordingState;
      }
      return { kind: "stale", session } as RecordingState;
    });
}
