import { existsSync } from "node:fs";
import type { Config } from "./types.js";

// macOS QoS clamp applied to whisper-cli / AudioAnalysis spawns so the Swift
// audio capture (which keeps default priority) never starves during a live
// recording. `utility` is the background-utility class — deprioritized under
// contention, full-speed otherwise, so it never stalls the live path (unlike a
// pressure gate). This complements P1: the live path stays un-gated, it just
// yields CPU to capture when they compete.
const TASKPOLICY_BIN = "/usr/sbin/taskpolicy";
const TASKPOLICY_QOS = "utility";

export interface QoSResult {
  command: string;
  args: string[];
  // true when we actually wrapped with taskpolicy (used by `meet doctor`).
  applied: boolean;
}

// Pure builder — unit-tested without touching the filesystem. Decides whether
// to wrap `command args...` as `taskpolicy -c utility command args...`.
// `enabled` = config switch, `available` = taskpolicy binary exists.
export function buildQoSArgs(
  command: string,
  args: string[],
  opts: { enabled: boolean; available: boolean },
): QoSResult {
  if (!opts.enabled || !opts.available) {
    return { command, args, applied: false };
  }
  return {
    command: TASKPOLICY_BIN,
    // taskpolicy stops option parsing at the first non-option argument, so the
    // wrapped binary path (even if absolute) and its `-m`/`-f`/… args are
    // forwarded verbatim as the program + pargs.
    args: ["-c", TASKPOLICY_QOS, command, ...args],
    applied: true,
  };
}

// taskpolicy existence is stable for the process lifetime — check once.
let availableCache: boolean | null = null;

export function _resetQoSCache(): void {
  availableCache = null;
}

// Synchronous existence check (taskpolicy ships at a fixed path on macOS). We
// avoid spawning a probe process because the spawn path itself is synchronous
// in the execFile callback; this keeps `applyQoS` cheap and non-blocking.
export function isTaskpolicyAvailable(): boolean {
  if (availableCache === null) {
    availableCache = existsSync(TASKPOLICY_BIN);
  }
  return availableCache;
}

// Wraps a spawn target with `taskpolicy -c utility` when the config enables it
// and taskpolicy is present. Fail-open: returns the input unchanged otherwise.
// Async only so future implementations can probe via execFile if needed; the
// current check is synchronous (existsSync) and resolves immediately.
export async function applyQoS(
  command: string,
  args: string[],
  config: Pick<Config, "lowerProcessPriority">,
): Promise<QoSResult> {
  return buildQoSArgs(command, args, {
    enabled: config.lowerProcessPriority,
    available: isTaskpolicyAvailable(),
  });
}
