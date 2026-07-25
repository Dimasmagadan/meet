import { existsSync } from "node:fs";
import type { Config } from "./types.js";

// macOS QoS clamp applied to whisper-cli / AudioAnalysis spawns so the Swift
// audio capture (which keeps default priority) never starves during a live
// recording. `utility` yields CPU under contention but never stalls, so the
// live path stays effectively un-gated (complementary to P1's pressure gate,
// which deliberately excludes the live path). See AGENTS.md for the full
// rationale. Fail-open: no wrapping when taskpolicy is absent.
const TASKPOLICY_BIN = "/usr/sbin/taskpolicy";
const TASKPOLICY_QOS = "utility";

export interface QoSResult {
  command: string;
  args: string[];
  applied: boolean;
}

// Pure builder — unit-tested without touching the filesystem. `enabled` =
// config switch, `available` = taskpolicy binary exists.
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
    // wrapped binary path and its `-m`/`--input`/… args are forwarded verbatim.
    args: ["-c", TASKPOLICY_QOS, command, ...args],
    applied: true,
  };
}

// taskpolicy existence is stable for the process lifetime — check once.
let availableCache: boolean | null = null;

export function _resetQoSCache(): void {
  availableCache = null;
}

export function isTaskpolicyAvailable(): boolean {
  if (availableCache === null) {
    availableCache = existsSync(TASKPOLICY_BIN);
  }
  return availableCache;
}

// Synchronous: both inputs (config flag + existsSync) are sync, so wrapping
// this in a Promise would just add an await for nothing across three hot
// spawn sites.
export function applyQoS(
  command: string,
  args: string[],
  config: Pick<Config, "lowerProcessPriority">,
): QoSResult {
  return buildQoSArgs(command, args, {
    enabled: config.lowerProcessPriority,
    available: isTaskpolicyAvailable(),
  });
}
