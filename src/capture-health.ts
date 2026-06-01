import type { AudioMetrics } from "./audio-metrics.js";
import { isDigitalSilence, isBelowSpeechThreshold } from "./audio-metrics.js";

export interface HealthWarning {
  type: "mic_missing" | "mic_silent" | "sys_silent" | "sys_missing";
  message: string;
}

export interface CaptureHealthConfig {
  micRmsThresholdDb: number;
  sysRmsThresholdDb: number;
  mode: "full" | "mic";
  chunkDurationSeconds: number;
  silentConsecutiveThreshold: number;
  micMissingChunkThreshold: number;
}

const DEFAULT_HEALTH_CONFIG: Omit<CaptureHealthConfig, "micRmsThresholdDb" | "sysRmsThresholdDb" | "mode" | "chunkDurationSeconds"> = {
  silentConsecutiveThreshold: 3,
  micMissingChunkThreshold: 2,
};

export class CaptureHealthMonitor {
  private config: CaptureHealthConfig;
  private lastMicChunkIndex: number = 0;
  private lastSysChunkIndex: number = 0;
  private consecutiveSilentSys: number = 0;
  private consecutiveSilentMic: number = 0;
  private micChunkCount: number = 0;
  private sysChunkCount: number = 0;
  private totalChunksProcessed: number = 0;
  private lastSysSilentWarningAt: number = Number.NEGATIVE_INFINITY;
  private warnedMicMissing: boolean = false;
  private warnedMicSilent: boolean = false;

  constructor(config: CaptureHealthConfig) {
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  recordChunk(
    source: "mic" | "sys",
    chunkIndex: number,
    metrics: AudioMetrics
  ): HealthWarning | null {
    this.totalChunksProcessed++;

    if (source === "mic") {
      this.micChunkCount++;
      this.lastMicChunkIndex = Math.max(this.lastMicChunkIndex, chunkIndex);

      if (isDigitalSilence(metrics) || isBelowSpeechThreshold("mic", metrics, this.config)) {
        this.consecutiveSilentMic++;
      } else {
        this.consecutiveSilentMic = 0;
        this.warnedMicSilent = false;
      }

      if (this.consecutiveSilentMic >= this.config.silentConsecutiveThreshold && !this.warnedMicSilent) {
        this.warnedMicSilent = true;
        return {
          type: "mic_silent",
          message: `Mic audio is silent for ${this.consecutiveSilentMic} consecutive chunks (last: rms ${metrics.rmsDb === -Infinity ? "-∞" : metrics.rmsDb.toFixed(0)} dB)`,
        };
      }
    } else {
      this.sysChunkCount++;
      this.lastSysChunkIndex = Math.max(this.lastSysChunkIndex, chunkIndex);

      if (isDigitalSilence(metrics) || isBelowSpeechThreshold("sys", metrics, this.config)) {
        this.consecutiveSilentSys++;
      } else {
        this.consecutiveSilentSys = 0;
        this.lastSysSilentWarningAt = Number.NEGATIVE_INFINITY;
      }

      if (
        this.consecutiveSilentSys >= this.config.silentConsecutiveThreshold &&
        this.totalChunksProcessed - this.lastSysSilentWarningAt > this.config.silentConsecutiveThreshold * 2
      ) {
        this.lastSysSilentWarningAt = this.totalChunksProcessed;
        return {
          type: "sys_silent",
          message: `System audio is silent for ${this.consecutiveSilentSys} consecutive chunks`,
        };
      }
    }

    return null;
  }

  checkMicMissing(): HealthWarning | null {
    if (this.config.mode !== "full" && this.config.mode !== "mic") return null;
    if (this.warnedMicMissing) return null;
    if (this.micChunkCount > 0) return null;

    const expectedMicChunks = Math.max(this.sysChunkCount, Math.floor(this.totalChunksProcessed / 2));
    if (expectedMicChunks >= this.config.micMissingChunkThreshold) {
      this.warnedMicMissing = true;
      return {
        type: "mic_missing",
        message: `Mic stream has not produced any chunks while ${this.sysChunkCount} system chunks were finalized`,
      };
    }

    return null;
  }

  getStats() {
    return {
      micChunkCount: this.micChunkCount,
      sysChunkCount: this.sysChunkCount,
      lastMicChunkIndex: this.lastMicChunkIndex,
      lastSysChunkIndex: this.lastSysChunkIndex,
      consecutiveSilentMic: this.consecutiveSilentMic,
      consecutiveSilentSys: this.consecutiveSilentSys,
    };
  }
}
