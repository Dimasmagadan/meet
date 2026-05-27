export type CaptureMode = "full" | "mic";

export interface Chunk {
  source: "mic" | "sys";
  index: number;
  wav: string;
  status: "done" | "failed" | "pending";
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
  status: "recording" | "finalizing" | "done" | "error";
  processedChunks: Chunk[];
  lastError: string | null;
  autoStopReason: "max_duration" | "no_text_timeout" | null;
  latestProcessedOffsetSeconds: number;
  lastMeaningfulTextAtOffsetSeconds: number | null;
  hasMeaningfulText: boolean;
  tags?: string[];
}

export interface Config {
  modelPath: string;
  liveModelPath: string;
  finalModelPath: string;
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

export interface AudioMetrics {
  rmsDb: number;
  peakDb: number;
}

export interface TranscriptEntry {
  source: "mic" | "sys";
  chunkIndex: number;
  timestamp: string;
  text: string;
}

export const DEFAULT_CONFIG: Config = {
  modelPath: "~/.meet/models/ggml-small.bin",
  liveModelPath: "~/.meet/models/ggml-small.bin",
  finalModelPath: "~/.meet/models/ggml-medium.bin",
  finalRetranscribe: true,
  keepLiveTranscript: true,
  outputDir: "~/Meetings",
  chunkDurationSeconds: 15,
  language: "ru",
  whisperBin: "whisper-cli",
  captureBin: "",
  prompt: "Транскрипция деловой встречи на русском языке.",
  opencodeBin: "opencode",
  micVoiceProcessing: false,
  silenceGate: true,
  micRmsThresholdDb: -60,
  sysRmsThresholdDb: -65,
  normalizeForWhisper: true,
  whisperEntropyThreshold: 2.0,
  whisperLogprobThreshold: -0.35,
  whisperNoSpeechThreshold: 0.75,
  maxDurationMinutes: 60,
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
