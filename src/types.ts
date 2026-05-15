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
}

export interface Config {
  modelPath: string;
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
}

export interface TranscriptEntry {
  source: "mic" | "sys";
  chunkIndex: number;
  timestamp: string;
  text: string;
}

export const DEFAULT_CONFIG: Config = {
  modelPath: "~/.meet/models/ggml-small.bin",
  outputDir: "~/Meetings",
  chunkDurationSeconds: 30,
  language: "ru",
  whisperBin: "whisper-cli",
  captureBin: "",
  prompt: "Транскрипция деловой встречи на русском языке.",
  opencodeBin: "opencode",
  micVoiceProcessing: false,
  silenceGate: true,
  micRmsThresholdDb: -65,
  sysRmsThresholdDb: -65,
  normalizeForWhisper: true,
  whisperEntropyThreshold: 2.0,
  whisperLogprobThreshold: -0.35,
  whisperNoSpeechThreshold: 0.75,
};
