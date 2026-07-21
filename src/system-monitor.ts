import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpus } from "node:os";

const execFileP = promisify(execFile);

export interface ResourcePressure {
  cpuLoad1min: number;
  cpuCores: number;
  freeMemoryMb: number;
  whisperRunning: boolean;
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

export async function getSystemPressure(
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
): Promise<ResourcePressure> {
  const cpuCores = cpus().length;

  const [load, freeMb, whisperRunning] = await Promise.all([
    readLoadavg(),
    readFreeMemoryMb(),
    isWhisperRunning(),
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

  return {
    cpuLoad1min: load ?? 0,
    cpuCores,
    freeMemoryMb: freeMb ?? 0,
    whisperRunning,
    overloaded,
    reason: reasons.length > 0 ? reasons.join(", ") : null,
  };
}
