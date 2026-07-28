import { DEFAULT_TRIGGERS_PATH } from "./triggers.js";
import { DEFAULT_PHRASEBOOK_PATH } from "./phrasebook.js";
import { DEFAULT_VOCABULARY_PATH } from "./vocabulary.js";
import type { GitContext } from "./git-context.js";

export type CaptureMode = "full" | "mic";

export interface Chunk {
  source: "mic" | "sys";
  index: number;
  wav: string;
  status: "done" | "failed" | "pending";
}

export type SessionStatus = "recording" | "stopped" | "queued" | "finalizing" | "paused" | "done" | "error";

export interface FinalizeProgress {
  phase: "stopping" | "live" | "final" | "write" | "diarize" | "ab" | "done" | "paused" | "error";
  done: number;
  total: number;
  message: string | null;
  pid: number | null;
  updatedAt: string;
}

export interface Session {
  id: string;
  title: string;
  mode: CaptureMode;
  startedAt: string;
  chunkDurationSeconds: number;
  sessionDir: string;
  outputFile: string;
  capturePid: number | null;
  status: SessionStatus;
  processedChunks: Chunk[];
  lastError: string | null;
  autoStopReason: "max_duration" | "no_text_timeout" | null;
  latestProcessedOffsetSeconds: number;
  lastMeaningfulTextAtOffsetSeconds: number | null;
  hasMeaningfulText: boolean;
  tags?: string[];
  gitContext?: GitContext | null; // captured at `meet start` (--repo or cwd); persisted into meta.md as a "- Repo:" line
  finalize?: FinalizeProgress;
}

export interface Config {
  modelPath: string;
  liveModelPath: string;
  finalModelPath: string;
  importModelPath: string;
  finalRetranscribe: boolean;
  keepLiveTranscript: boolean;
  outputDir: string;
  chunkDurationSeconds: number;
  language: string;
  whisperBin: string;
  captureBin: string;
  prompt: string;
  opencodeBin: string;
  micVoiceProcessing: boolean;
  silenceGate: boolean;
  micRmsThresholdDb: number;
  sysRmsThresholdDb: number;
  normalizeForWhisper: boolean;
  whisperEntropyThreshold: number;
  whisperLogprobThreshold: number;
  whisperNoSpeechThreshold: number;
  finalEntropyThreshold: number;
  finalLogprobThreshold: number;
  finalNoSpeechThreshold: number;
  finalBeamSize: number;
  finalBestOf: number;
  maxDurationMinutes: number;
  noTextTimeoutMinutes: number;
  phrasebookPath: string;
  phrasebookReload: boolean;
  vadEnabled: boolean;
  vadBin: string;
  vadMinSpeechMs: number;
  vadThreshold: number;
  vadFailOpen: boolean;
  vadTimeoutMs: number;
  diarizationEnabled: boolean;
  diarizationMinOverlap: number;
  // S2: opt-in parallel offline-VBx diarization pass for A/B comparison
  // against the primary online pipeline. Writes diarization-ab-report.json;
  // never touches transcript.md.
  diarizationAbPass: boolean;
  analysisBin: string;
  parakeetComparePass: boolean;
  attentionAlerts: boolean;
  triggersPath: string;
  triggersReload: boolean;
  vocabularyPath: string;
  vocabularyReload: boolean;
  attentionCooldownSeconds: number;
  attentionRecapEntries: number;
  attentionSound: string;
  summaryEnabled: boolean;
  summaryIntervalChunks: number;
  summaryTopN: number;
  summaryWindowMaxEntries: number;
  summaryMinEntries: number;
  summaryCpuThresholdLoad: number;
  summaryMemThresholdMb: number;
  summaryCatchupIntervalMs: number;
  opencodeIndexPass: boolean;
  gateHeavyPasses: boolean;
  gateBudgetMs: number;
  speakerRegistryEnabled: boolean;
  speakerMatchThreshold: number;
  speakerRegistryPath: string;
  // P3: spawn whisper-cli / AudioAnalysis under `taskpolicy -c utility` so the
  // Swift audio capture (which keeps default priority) never starves during a
  // live recording. Fail-opens to no wrapping when taskpolicy is unavailable.
  lowerProcessPriority: boolean;
  // P5: live-queue lag (in chunks) above which the status line warns. Visibility only — no dropping.
  liveQueueLagWarnChunks: number;
}

export interface TranscribeOptions {
  modelPath?: string;
  pass?: "live" | "final";
}

export interface MeetingStats {
  title: string;
  date: Date;
  mode: string;
  tags: string[];
  repo?: { repoName: string; headSha: string; branch: string | null } | null;
  durationSeconds: number | null;
  wordCount: number;
  talkTime?: { me: number; others: number; speakerCount: number };
  dayOfWeek: number;
  hour: number;
  weekKey: string;
  monthKey: string;
}

export interface AudioMetrics {
  rmsDb: number;
  peakDb: number;
  sampleCount?: number;
}

export interface TranscriptEntry {
  source: "mic" | "sys" | "file";
  chunkIndex: number;
  timestamp: string;
  text: string;
  speaker?: string;
}

export interface EntryRecord {
  source: "mic" | "sys";
  index: number;
  timestamp: string;
  text: string;
  rmsDb: number;
}

export const DEFAULT_CONFIG: Config = {
  modelPath: "~/.meet/models/ggml-small.bin",
  liveModelPath: "~/.meet/models/ggml-small.bin",
  finalModelPath: "~/.meet/models/ggml-medium.bin",
  importModelPath: "",
  finalRetranscribe: true,
  keepLiveTranscript: true,
  outputDir: "~/Meetings",
  chunkDurationSeconds: 15,
  language: "ru",
  whisperBin: "whisper-cli",
  captureBin: "",
  prompt: "Разговор на русском языке. Консультация, обсуждение, вопросы и ответы.",
  opencodeBin: "opencode",
  micVoiceProcessing: false,
  silenceGate: true,
  micRmsThresholdDb: -60,
  sysRmsThresholdDb: -65,
  normalizeForWhisper: true,
  whisperEntropyThreshold: 2.4,
  whisperLogprobThreshold: -1.0,
  whisperNoSpeechThreshold: 0.6,
  finalEntropyThreshold: 1.5,
  finalLogprobThreshold: -1.5,
  finalNoSpeechThreshold: 0.7,
  finalBeamSize: 5,
  finalBestOf: 3,
  maxDurationMinutes: 75,
  noTextTimeoutMinutes: 10,
  phrasebookPath: DEFAULT_PHRASEBOOK_PATH,
  phrasebookReload: true,
  vadEnabled: false,
  vadBin: "",
  vadMinSpeechMs: 250,
  vadThreshold: 0.5,
  vadFailOpen: true,
  vadTimeoutMs: 30_000,
  diarizationEnabled: true,
  diarizationMinOverlap: 0.3,
  diarizationAbPass: false,
  analysisBin: "",
  parakeetComparePass: true,
  attentionAlerts: true,
  triggersPath: DEFAULT_TRIGGERS_PATH,
  triggersReload: true,
  vocabularyPath: DEFAULT_VOCABULARY_PATH,
  vocabularyReload: true,
  attentionCooldownSeconds: 60,
  attentionRecapEntries: 3,
  attentionSound: "Glass",
  summaryEnabled: true,
  summaryIntervalChunks: 8,
  summaryTopN: 5,
  summaryWindowMaxEntries: 200,
  summaryMinEntries: 8,
  summaryCpuThresholdLoad: 6,
  summaryMemThresholdMb: 768,
  summaryCatchupIntervalMs: 30_000,
  opencodeIndexPass: false,
  gateHeavyPasses: true,
  gateBudgetMs: 120_000,
  speakerRegistryEnabled: false,
  speakerMatchThreshold: 0.75,
  speakerRegistryPath: "~/.meet/speakers/registry.json",
  lowerProcessPriority: true,
  liveQueueLagWarnChunks: 8,
};
