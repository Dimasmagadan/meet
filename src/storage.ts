import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Chunk, Session, Config, TranscriptEntry } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { isPidAlive, readActiveRecordingLock, readFinalizerLock } from "./locks.js";
import { classifyRecordingSessions, type RecordingState } from "./recording-state.js";

const WHISPER_CANDIDATES = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];

export function resolveWhisperBin(config: Config): string {
  if (config.whisperBin && config.whisperBin !== "whisper-cli") {
    return expandPath(config.whisperBin);
  }
  return WHISPER_CANDIDATES.find((p) => existsSync(p)) ?? "whisper-cli";
}

export function resolveModelPath(config: Config, pass: "live" | "final"): string {
  const raw = pass === "final"
    ? (config.finalModelPath || config.modelPath)
    : (config.liveModelPath || config.modelPath);
  return expandPath(raw);
}

export function expandPath(p: string): string {
  return p.startsWith("~/") || p === "~" ? p.replace(/^~/, homedir()) : p;
}

export function normalizePath(p: string): string {
  return resolve(expandPath(p));
}

export function getSessionsDir(): string {
  const dir = join(homedir(), ".meet", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// loadConfig() runs per-chunk (pipeline.ts's processNext) — a malformed
// config.json used to throw there, failing every chunk until fixed. This
// caches the last successfully validated config so a bad edit degrades to
// "keep using what worked" instead of crashing the live pipeline.
let lastValidFileConfig: Partial<Config> = {};
const configWarn = createWarnOnce();

// Drops any key whose value isn't the same primitive type as its DEFAULT_CONFIG
// counterpart (or, for numbers, isn't finite) instead of letting a garbage
// value (e.g. a string where a threshold number is expected, or NaN) flow
// unvalidated into VAD/filtering/diarization comparisons.
export function sanitizeFileConfig(raw: Record<string, unknown>): Partial<Config> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const defaultValue = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    if (defaultValue === undefined) continue; // unknown key, ignore
    const expectedType = typeof defaultValue;
    const actualType = typeof value;
    if (actualType !== expectedType) {
      configWarn(`config:${key}:type`, `~/.meet/config.json: "${key}" expected ${expectedType}, got ${actualType} — using default`);
      continue;
    }
    if (expectedType === "number" && !Number.isFinite(value as number)) {
      configWarn(`config:${key}:finite`, `~/.meet/config.json: "${key}" is not a finite number — using default`);
      continue;
    }
    if (!isValidConfigValue(key, value)) {
      configWarn(`config:${key}:range`, `~/.meet/config.json: "${key}" has an unsafe value — using default`);
      continue;
    }
    clean[key] = value;
  }
  return clean as Partial<Config>;
}

function isValidConfigValue(key: string, value: unknown): boolean {
  const number = value as number;
  const positiveIntegers = new Set([
    "chunkDurationSeconds", "finalBeamSize", "finalBestOf", "vadMinSpeechMs", "vadTimeoutMs",
    "attentionCooldownSeconds", "attentionRecapEntries", "summaryIntervalChunks", "summaryTopN",
    "summaryWindowMaxEntries", "summaryMinEntries", "summaryMemThresholdMb", "summaryCatchupIntervalMs",
    "gateBudgetMs", "liveQueueLagWarnChunks",
  ]);
  const nonNegativeNumbers = new Set(["maxDurationMinutes", "noTextTimeoutMinutes"]);
  const unitIntervals = new Set([
    "whisperNoSpeechThreshold", "finalNoSpeechThreshold", "vadThreshold", "diarizationMinOverlap",
    "micEchoCoverageThreshold", "micEchoCorrelationThreshold", "micEchoFractionThreshold", "speakerMatchThreshold",
  ]);
  if (positiveIntegers.has(key)) return Number.isSafeInteger(number) && number > 0;
  if (nonNegativeNumbers.has(key)) return Number.isFinite(number) && number >= 0;
  if (unitIntervals.has(key)) return Number.isFinite(number) && number >= 0 && number <= 1;
  if (["micRmsThresholdDb", "sysRmsThresholdDb", "whisperEntropyThreshold", "whisperLogprobThreshold", "finalEntropyThreshold", "finalLogprobThreshold", "summaryCpuThresholdLoad"].includes(key)) return Number.isFinite(number);
  if (["outputDir", "whisperBin", "language", "modelPath", "liveModelPath", "finalModelPath"].includes(key)) return typeof value === "string" && value.trim().length > 0;
  return true;
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const configPath = expandPath("~/.meet/config.json");
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      lastValidFileConfig = sanitizeFileConfig(parsed);
    } catch (err) {
      configWarn("config:parse", `~/.meet/config.json is invalid (${err instanceof Error ? err.message : String(err)}) — keeping last known-good config`);
    }
  }
  return { ...DEFAULT_CONFIG, ...lastValidFileConfig, ...overrides };
}

// Returns a function that logs each distinct error `key` to stderr once,
// so persistent failures (e.g. disk full) don't spam output on every chunk.
export function createWarnOnce(): (key: string, err: unknown) => void {
  const seen = new Set<string>();
  return (key: string, err: unknown) => {
    if (seen.has(key)) return;
    seen.add(key);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[meet] ${key}: ${msg}`);
  };
}

export async function writeAtomic(filePath: string, data: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, data, "utf-8");
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function readSession(sessionDir: string): Promise<Session | null> {
  const path = join(sessionDir, "session.json");
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf-8"));
}

export async function writeSession(session: Session): Promise<void> {
  const path = join(session.sessionDir, "session.json");
  await writeAtomic(path, JSON.stringify(session, null, 2));
}

export function generateSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "");
  return slug || "meeting";
}

export function formatStartTime(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d}_${h}-${min}`;
}

export function getOutputDir(config: Config, title: string, startedAt: Date): string {
  const baseDir = expandPath(config.outputDir);
  const slug = generateSlug(title);
  const ts = formatStartTime(startedAt);
  return join(baseDir, `${ts}-${slug}`);
}

export function getOutputPath(config: Config, title: string, startedAt: Date): string {
  return join(getOutputDir(config, title, startedAt), "transcript.md");
}

// Atomically claims a meeting output directory: minute-precision timestamp +
// title slug collide whenever two starts/imports land in the same clock
// minute with the same title. `mkdir` without `recursive` fails EEXIST for
// an already-claimed path, so each collision just tries the next numeric
// suffix instead of silently reusing (and overwriting) another meeting's dir.
export async function reserveOutputDir(config: Config, title: string, startedAt: Date): Promise<string> {
  const baseDir = expandPath(config.outputDir);
  await mkdir(baseDir, { recursive: true });
  const base = `${formatStartTime(startedAt)}-${generateSlug(title)}`;
  for (let n = 1; ; n++) {
    const dir = join(baseDir, n === 1 ? base : `${base}-${n}`);
    try {
      await mkdir(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
  }
}

export function getCaptureBinPath(config?: Config): string {
  if (config?.captureBin) return expandPath(config.captureBin);
  const repoRoot = resolve(import.meta.dirname, "..");
  return join(repoRoot, "native", "AudioCapture", ".build", "release", "AudioCapture");
}

export function resolveAnalysisBin(config?: Config): string {
  if (config?.analysisBin) return expandPath(config.analysisBin);
  const repoRoot = resolve(import.meta.dirname, "..");
  return join(repoRoot, "native", "AudioCapture", ".build", "release", "AudioAnalysis");
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(expandPath(path), { recursive: true });
}

export function findStaleSessions(): string[] {
  return findRecordingStates().filter((state) => state.kind === "stale").map((state) => state.session.sessionDir);
}

export function findRecordingStates(): RecordingState[] {
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) return [];
  try {
    const sessions = readdirSync(sessionsDir)
      .filter((e: string) => e.startsWith("meet-"))
      .map((e: string) => join(sessionsDir, e))
      .filter((e: string) => existsSync(join(e, "session.json")))
      .flatMap((e: string) => {
        try {
          const s = JSON.parse(readFileSync(join(e, "session.json"), "utf-8")) as Session;
          if ((s.status === "finalizing" || s.status === "paused") && readFinalizerLock(e) !== null) return [];
          return [s];
        } catch {
          return [];
        }
      });
    return classifyRecordingSessions(sessions, readActiveRecordingLock(), isPidAlive);
  } catch {
    return [];
  }
}
