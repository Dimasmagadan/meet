import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Chunk, Session, Config, TranscriptEntry } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import { readFinalizerLock } from "./locks.js";

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

export function getSessionsDir(): string {
  const dir = join(homedir(), ".meet", "sessions");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(overrides?: Partial<Config>): Config {
  const configPath = expandPath("~/.meet/config.json");
  let fileConfig: Partial<Config> = {};
  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    fileConfig = JSON.parse(raw);
  }
  return {
    modelPath: overrides?.modelPath ?? fileConfig.modelPath ?? DEFAULT_CONFIG.modelPath,
    liveModelPath: overrides?.liveModelPath ?? fileConfig.liveModelPath ?? DEFAULT_CONFIG.liveModelPath,
    finalModelPath: overrides?.finalModelPath ?? fileConfig.finalModelPath ?? DEFAULT_CONFIG.finalModelPath,
    importModelPath: overrides?.importModelPath ?? fileConfig.importModelPath ?? DEFAULT_CONFIG.importModelPath,
    finalRetranscribe: overrides?.finalRetranscribe ?? fileConfig.finalRetranscribe ?? DEFAULT_CONFIG.finalRetranscribe,
    keepLiveTranscript: overrides?.keepLiveTranscript ?? fileConfig.keepLiveTranscript ?? DEFAULT_CONFIG.keepLiveTranscript,
    outputDir: overrides?.outputDir ?? fileConfig.outputDir ?? DEFAULT_CONFIG.outputDir,
    chunkDurationSeconds: overrides?.chunkDurationSeconds ?? fileConfig.chunkDurationSeconds ?? DEFAULT_CONFIG.chunkDurationSeconds,
    language: overrides?.language ?? fileConfig.language ?? DEFAULT_CONFIG.language,
    whisperBin: overrides?.whisperBin ?? fileConfig.whisperBin ?? DEFAULT_CONFIG.whisperBin,
    captureBin: overrides?.captureBin ?? fileConfig.captureBin ?? DEFAULT_CONFIG.captureBin,
    prompt: overrides?.prompt ?? fileConfig.prompt ?? DEFAULT_CONFIG.prompt,
    opencodeBin: overrides?.opencodeBin ?? fileConfig.opencodeBin ?? DEFAULT_CONFIG.opencodeBin,
    micVoiceProcessing: overrides?.micVoiceProcessing ?? fileConfig.micVoiceProcessing ?? DEFAULT_CONFIG.micVoiceProcessing,
    silenceGate: overrides?.silenceGate ?? fileConfig.silenceGate ?? DEFAULT_CONFIG.silenceGate,
    micRmsThresholdDb: overrides?.micRmsThresholdDb ?? fileConfig.micRmsThresholdDb ?? DEFAULT_CONFIG.micRmsThresholdDb,
    sysRmsThresholdDb: overrides?.sysRmsThresholdDb ?? fileConfig.sysRmsThresholdDb ?? DEFAULT_CONFIG.sysRmsThresholdDb,
    normalizeForWhisper: overrides?.normalizeForWhisper ?? fileConfig.normalizeForWhisper ?? DEFAULT_CONFIG.normalizeForWhisper,
    whisperEntropyThreshold: overrides?.whisperEntropyThreshold ?? fileConfig.whisperEntropyThreshold ?? DEFAULT_CONFIG.whisperEntropyThreshold,
    whisperLogprobThreshold: overrides?.whisperLogprobThreshold ?? fileConfig.whisperLogprobThreshold ?? DEFAULT_CONFIG.whisperLogprobThreshold,
    whisperNoSpeechThreshold: overrides?.whisperNoSpeechThreshold ?? fileConfig.whisperNoSpeechThreshold ?? DEFAULT_CONFIG.whisperNoSpeechThreshold,
    finalEntropyThreshold: overrides?.finalEntropyThreshold ?? fileConfig.finalEntropyThreshold ?? DEFAULT_CONFIG.finalEntropyThreshold,
    finalLogprobThreshold: overrides?.finalLogprobThreshold ?? fileConfig.finalLogprobThreshold ?? DEFAULT_CONFIG.finalLogprobThreshold,
    finalNoSpeechThreshold: overrides?.finalNoSpeechThreshold ?? fileConfig.finalNoSpeechThreshold ?? DEFAULT_CONFIG.finalNoSpeechThreshold,
    finalBeamSize: overrides?.finalBeamSize ?? fileConfig.finalBeamSize ?? DEFAULT_CONFIG.finalBeamSize,
    finalBestOf: overrides?.finalBestOf ?? fileConfig.finalBestOf ?? DEFAULT_CONFIG.finalBestOf,
    maxDurationMinutes: overrides?.maxDurationMinutes ?? fileConfig.maxDurationMinutes ?? DEFAULT_CONFIG.maxDurationMinutes,
    noTextTimeoutMinutes: overrides?.noTextTimeoutMinutes ?? fileConfig.noTextTimeoutMinutes ?? DEFAULT_CONFIG.noTextTimeoutMinutes,
    phrasebookPath: overrides?.phrasebookPath ?? fileConfig.phrasebookPath ?? DEFAULT_CONFIG.phrasebookPath,
    phrasebookReload: overrides?.phrasebookReload ?? fileConfig.phrasebookReload ?? DEFAULT_CONFIG.phrasebookReload,
    vadEnabled: overrides?.vadEnabled ?? fileConfig.vadEnabled ?? DEFAULT_CONFIG.vadEnabled,
    vadBin: overrides?.vadBin ?? fileConfig.vadBin ?? DEFAULT_CONFIG.vadBin,
    vadMinSpeechMs: overrides?.vadMinSpeechMs ?? fileConfig.vadMinSpeechMs ?? DEFAULT_CONFIG.vadMinSpeechMs,
    vadThreshold: overrides?.vadThreshold ?? fileConfig.vadThreshold ?? DEFAULT_CONFIG.vadThreshold,
    vadFailOpen: overrides?.vadFailOpen ?? fileConfig.vadFailOpen ?? DEFAULT_CONFIG.vadFailOpen,
    vadTimeoutMs: overrides?.vadTimeoutMs ?? fileConfig.vadTimeoutMs ?? DEFAULT_CONFIG.vadTimeoutMs,
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
  return title
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);
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

export function getCaptureBinPath(): string {
  const repoRoot = resolve(import.meta.dirname, "..");
  return join(repoRoot, "native", "AudioCapture", ".build", "release", "AudioCapture");
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(expandPath(path), { recursive: true });
}

export function findStaleSessions(): string[] {
  const sessionsDir = getSessionsDir();
  if (!existsSync(sessionsDir)) return [];
  try {
    const entries = readdirSync(sessionsDir);
    return entries
      .filter((e: string) => e.startsWith("meet-"))
      .map((e: string) => join(sessionsDir, e))
      .filter((e: string) => existsSync(join(e, "session.json")))
      .filter((e: string) => {
        try {
          const s = JSON.parse(readFileSync(join(e, "session.json"), "utf-8")) as Session;
          if (s.status === "done" || s.status === "recording") return false;
          if (s.status === "error" || s.status === "stopped" || s.status === "queued") return true;
          if (s.status === "finalizing" || s.status === "paused") {
            return readFinalizerLock(e) === null;
          }
          return true;
        } catch {
          return true;
        }
      });
  } catch {
    return [];
  }
}
