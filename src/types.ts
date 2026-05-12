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
  chunkDurationSeconds: 15,
  language: "ru",
  whisperBin: "whisper-cli",
  captureBin: "",
};
