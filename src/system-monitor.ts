import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpus } from "node:os";
import { isActiveRecording } from "./locks.js";
import type { Config } from "./types.js";

const execFileP = promisify(execFile);

export interface ResourcePressure {
  cpuLoad1min: number;
  cpuCores: number;
  freeMemoryMb: number;
  whisperRunning: boolean;
  audioAnalysisRunning: boolean;
  overloaded: boolean;
  reason: string | null;
}

export interface PressureThresholds {
  cpuThresholdLoad: number;
  memThresholdMb: number;
}

export const DEFAULT_PRESSURE_THRESHOLDS: PressureThresholds = {
  cpuThresholdLoad: 6,
  memThresholdMb: 768,
};

const PGREP_CACHE_MS = 5_000;

let whisperCacheAt = 0;
let whisperCachedValue = false;
let whisperCachedChecked = false;

let audioAnalysisCacheAt = 0;
let audioAnalysisCachedValue = false;
let audioAnalysisCachedChecked = false;

// Parse `sysctl -n vm.loadavg`. Real macOS output formats seen in the wild:
//   "{ 1.59 1.45 1.50 }"               (no commas — most common)
//   "{ 1.23, 1.45, 1.50 }"             (commas)
//   "{ (5, 10, 60) = 1.23, 1.45, 1.50 }" (verbose label form)
// The first number after `{` (or after `=` in the verbose form) is the 1-min avg.
// Returns null on any parse failure (fail-open).
export function parseLoadavg(stdout: string): number | null {
  const verbose = stdout.match(/=\s*(-?[\d.]+)/);
  if (verbose) {
    const v = Number(verbose[1]);
    if (Number.isFinite(v)) return v;
  }
  const plain = stdout.match(/\{\s*(-?[\d.]+)/);
  if (plain) {
    const v = Number(plain[1]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// Parse macOS `vm_stat` page counts. Returns free memory in MB or null.
// "free" here = free + inactive pages × 4096 bytes, the conventional
// approximation of reclaimable memory on darwin.
export function parseFreeMemoryMb(stdout: string, pageSize: number = 4096): number | null {
  const freeMatch = stdout.match(/Pages free:\s+(\d+)/);
  const inactiveMatch = stdout.match(/Pages inactive:\s+(\d+)/);
  if (!freeMatch) return null;
  const free = Number(freeMatch[1]);
  const inactive = inactiveMatch ? Number(inactiveMatch[1]) : 0;
  if (!Number.isFinite(free)) return null;
  const pages = free + (Number.isFinite(inactive) ? inactive : 0);
  return Math.round((pages * pageSize) / (1024 * 1024));
}

async function readLoadavg(): Promise<number | null> {
  try {
    const { stdout } = await execFileP("sysctl", ["-n", "vm.loadavg"]);
    return parseLoadavg(stdout);
  } catch {
    return null;
  }
}

async function readFreeMemoryMb(): Promise<number | null> {
  try {
    const { stdout } = await execFileP("vm_stat");
    return parseFreeMemoryMb(stdout);
  } catch {
    return null;
  }
}

// pgrep cached for PGREP_CACHE_MS so repeated checks within a single
// status tick don't spawn multiple subprocesses. On any error, returns false
// (whisper signal is informational only; CPU threshold is the real gate).
export async function isWhisperRunning(): Promise<boolean> {
  const now = Date.now();
  if (now - whisperCacheAt < PGREP_CACHE_MS && whisperCachedChecked) {
    return whisperCachedValue;
  }
  whisperCacheAt = now;
  whisperCachedChecked = true;
  try {
    // execFile resolves pgrep via PATH. On macOS it ships at /usr/bin/pgrep.
    // Any error (missing binary, non-zero exit) fails open to false — whisper
    // detection is informational; the CPU threshold is the real gate.
    const { stdout } = await execFileP("pgrep", ["-f", "whisper-cli"]);
    whisperCachedValue = stdout.trim().length > 0;
  } catch {
    whisperCachedValue = false;
  }
  return whisperCachedValue;
}

// Visible for tests — resets the cache so a fake clock can move forward.
export function _resetWhisperCache(): void {
  whisperCacheAt = 0;
  whisperCachedChecked = false;
  whisperCachedValue = false;
}

// Mirrors isWhisperRunning but for the AudioAnalysis (FluidAudio/CoreML) binary,
// which backs diarize + parakeet passes. P4: previously the gate only saw
// whisper-cli, so CoreML pressure from diarize/parakeet was invisible.
export async function isAudioAnalysisRunning(): Promise<boolean> {
  const now = Date.now();
  if (now - audioAnalysisCacheAt < PGREP_CACHE_MS && audioAnalysisCachedChecked) {
    return audioAnalysisCachedValue;
  }
  audioAnalysisCacheAt = now;
  audioAnalysisCachedChecked = true;
  try {
    const { stdout } = await execFileP("pgrep", ["-f", "AudioAnalysis"]);
    audioAnalysisCachedValue = stdout.trim().length > 0;
  } catch {
    audioAnalysisCachedValue = false;
  }
  return audioAnalysisCachedValue;
}

export function _resetAudioAnalysisCache(): void {
  audioAnalysisCacheAt = 0;
  audioAnalysisCachedChecked = false;
  audioAnalysisCachedValue = false;
}

export async function getSystemPressure(
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
): Promise<ResourcePressure> {
  const cpuCores = cpus().length;

  const [load, freeMb, whisperRunning, audioAnalysisRunning] = await Promise.all([
    readLoadavg(),
    readFreeMemoryMb(),
    isWhisperRunning(),
    isAudioAnalysisRunning(),
  ]);

  let overloaded = false;
  const reasons: string[] = [];

  if (load !== null && load > thresholds.cpuThresholdLoad) {
    overloaded = true;
    reasons.push(`cpu ${load.toFixed(1)}/${cpuCores}c`);
  }
  if (freeMb !== null && freeMb < thresholds.memThresholdMb) {
    overloaded = true;
    reasons.push(`mem ${freeMb}MB`);
  }

  // Surface which heavy child is contributing so the gate's reason and
  // `meet doctor` can attribute the pressure. Deliberately NOT folded into the
  // `overloaded` boolean itself: a multi-chunk pass (final/parakeet) spawns,
  // awaits, then exits one child per chunk, so the pgrep cache (5s) is
  // stale-true immediately after a child exits. OR-ing it into `overloaded`
  // would make the per-chunk gate back off during its OWN pass, manufacturing
  // seconds of artificial delay per chunk. The load/mem thresholds already
  // capture the host pressure these children create.
  if (overloaded) {
    const heavy: string[] = [];
    if (whisperRunning) heavy.push("whisper");
    if (audioAnalysisRunning) heavy.push("audioAnalysis");
    if (heavy.length > 0) reasons.push(heavy.join("+"));
  }

  return {
    cpuLoad1min: load ?? 0,
    cpuCores,
    freeMemoryMb: freeMb ?? 0,
    whisperRunning,
    audioAnalysisRunning,
    overloaded,
    reason: reasons.length > 0 ? reasons.join(", ") : null,
  };
}

// --- P1: system-pressure gate for heavy batch passes -----------------------

// A wall-clock budget for a single gated pass. `remainingMs()` decreases over
// the life of the pass so the TOTAL wait across all per-chunk gate checks is
// bounded by the budget (NOT N × maxWaitMs — the per-call cap was explicitly
// rejected in the spec because it doesn't bound total finalize time).
export interface PressureDeadline {
  pollMs?: number;
  remainingMs(): number;
}

// Sensor is injectable so batch passes (and their tests) can swap a fake. The
// default is the real getSystemPressure.
export type PressureSensor = () => Promise<ResourcePressure>;

export const DEFAULT_GATE_POLL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeDeadline(budgetMs: number): PressureDeadline {
  const start = Date.now();
  return {
    remainingMs: () => Math.max(0, budgetMs - (Date.now() - start)),
  };
}

// --- heavy-pass throttle: gate thresholds from config + recording pause ----

// Auto load threshold as a fraction of the reported core count. loadavg is a
// runqueue depth, so "70% of the machine" reads directly in these units.
export const AUTO_LOAD_FACTOR = 0.7;

// gateLoadAvg 0 means "derive from the machine" (70% of cores); gateFreeMemMb
// 0 falls back to the legacy default. Numbers so the config stays a plain
// primitive — resolveGateThresholds does the auto math at use time.
export function resolveGateThresholds(
  config: Pick<Config, "gateLoadAvg" | "gateFreeMemMb">,
  cores: number = cpus().length,
): PressureThresholds {
  return {
    cpuThresholdLoad: config.gateLoadAvg > 0
      ? config.gateLoadAvg
      : Math.round(cores * AUTO_LOAD_FACTOR * 10) / 10,
    memThresholdMb: config.gateFreeMemMb > 0
      ? config.gateFreeMemMb
      : DEFAULT_PRESSURE_THRESHOLDS.memThresholdMb,
  };
}

export interface ThrottleOptions {
  sensor?: PressureSensor;
  isRecordingActive?: () => boolean;
  // Defaults to a stderr line per hold episode — background finalizers capture
  // stderr, foreground ones interleave it with progress output.
  notify?: (message: string) => void;
}

// The per-chunk hold every heavy batch pass awaits. Two independent back-off
// causes, checked in order:
//   1. gateWhileRecording — a live recording is active: hold (unbounded). A
//      back-to-back calendar call must always beat a stale finalization, so
//      this pause deliberately ignores the pass deadline.
//   2. host pressure (loadavg / free memory via resolveGateThresholds) — hold
//      while the pass deadline still has budget, then fail-open so a
//   sustained load spike can delay a pass but never starve it forever.
export async function throttleHold(
  config: Config,
  deadline: PressureDeadline | null,
  stage: string,
  opts: ThrottleOptions = {},
): Promise<void> {
  const sensor = opts.sensor ?? getSystemPressure;
  const isRecordingActive = opts.isRecordingActive ?? isActiveRecording;
  const notify = opts.notify ?? ((message: string) => console.error(`[meet] ${message}`));
  const pollMs = config.gatePollMs > 0 ? config.gatePollMs : DEFAULT_GATE_POLL_MS;
  const thresholds = resolveGateThresholds(config);
  const loadWaitEnabled = config.gateHeavyPasses && deadline !== null;
  const recordingWaitEnabled = config.gateHeavyPasses && config.gateWhileRecording && deadline !== null;
  let holdReason: string | null = null;

  for (;;) {
    if (recordingWaitEnabled && isRecordingActive()) {
      if (holdReason !== "recording") {
        holdReason = "recording";
        notify(`${stage}: holding while a recording is active`);
      }
      await sleep(pollMs);
      continue;
    }
    if (!loadWaitEnabled) return;
    let pressure: ResourcePressure;
    try {
      pressure = await sensor();
    } catch {
      return; // sensor unavailable → fail-open
    }
    if (!pressure.overloaded) return;
    const remaining = deadline!.remainingMs();
    if (remaining <= 0) return; // pass budget exhausted → fail-open
    if (holdReason === null || !holdReason.startsWith("load")) {
      holdReason = `load: ${pressure.reason ?? "overloaded"}`;
      notify(`${stage}: holding (${pressure.reason ?? "overloaded"})`);
    }
    await sleep(Math.min(pollMs, remaining));
  }
}
