export type CaptureMode = "full" | "mic";

export interface Chunk {
  source: "mic" | "sys";
  index: number;
  wav: string;
  status: "done" | "failed" | "pending";
}

export type SessionStatus = "recording" | "stopped" | "queued" | "finalizing" | "paused" | "done" | "error";

export interface FinalizeProgress {
  phase: "stopping" | "live" | "final" | "write" | "done" | "paused" | "error";
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
  durationSeconds: number | null;
  wordCount: number;
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
  phrasebookPath: "~/.meet/phrasebook.json",
  phrasebookReload: true,
  vadEnabled: false,
  vadBin: "",
  vadMinSpeechMs: 250,
  vadThreshold: 0.5,
  vadFailOpen: true,
  vadTimeoutMs: 30_000,
};
