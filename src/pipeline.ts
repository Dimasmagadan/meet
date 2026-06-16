import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import chokidar from "chokidar";
import type { Session, Config } from "./types.js";
import { writeSession, loadConfig } from "./storage.js";
import { transcribeChunk, parseChunkFilename } from "./transcriber.js";
import { analyzeWavFile } from "./audio-metrics.js";
import { CaptureHealthMonitor, type HealthWarning, type CaptureHealthConfig } from "./capture-health.js";
import { appendEntryRecord } from "./entries-store.js";

type TranscribeCallback = (source: "mic" | "sys", index: number, text: string) => void;
type FailureCallback = (source: "mic" | "sys", index: number, error: string) => void;
export type DrainProgress = { done: number; total: number };
export type DrainProgressCallback = (progress: DrainProgress) => void;
export type BeforeChunkCallback = () => Promise<void>;
export type HealthWarningCallback = (warning: HealthWarning) => void;

export class Pipeline {
  private session: Session;
  private watcher: chokidar.FSWatcher | null = null;
  private queue: Array<{ source: "mic" | "sys"; index: number; wav: string }> = [];
  private processing = false;
  private results = new Map<string, string>();
  private onTranscribed: TranscribeCallback | null = null;
  private onFailure: FailureCallback | null = null;
  private onHealthWarning: HealthWarningCallback | null = null;
  private stopped = false;
  private drainMode = false;
  private drainProgressCb: DrainProgressCallback | null = null;
  private drainBeforeChunk: BeforeChunkCallback | null = null;
  private completedDuringDrain = 0;
  private drainTotal = 0;
  private healthMonitor: CaptureHealthMonitor | null = null;
  private healthCheckCounter = 0;

  constructor(session: Session) {
    this.session = session;
  }

  setTranscribeCallback(cb: TranscribeCallback) {
    this.onTranscribed = cb;
  }

  setFailureCallback(cb: FailureCallback) {
    this.onFailure = cb;
  }

  setHealthWarningCallback(cb: HealthWarningCallback) {
    this.onHealthWarning = cb;
  }

  initHealthMonitor(config: Config) {
    const healthConfig: CaptureHealthConfig = {
      micRmsThresholdDb: config.micRmsThresholdDb,
      sysRmsThresholdDb: config.sysRmsThresholdDb,
      mode: this.session.mode,
      chunkDurationSeconds: this.session.chunkDurationSeconds,
      silentConsecutiveThreshold: 3,
      micMissingChunkThreshold: 2,
    };
    this.healthMonitor = new CaptureHealthMonitor(healthConfig);
  }

  getResults(): Map<string, string> {
    return this.results;
  }

  start() {
    this.rescan();

    this.watcher = chokidar.watch(join(this.session.sessionDir, "*.wav"), {
      ignored: /.*\.wav\.tmp$/,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100,
      },
    });

    this.watcher.on("add", (filePath) => {
      const filename = filePath.split("/").pop()!;
      const parsed = parseChunkFilename(filename);
      if (!parsed) return;
      this.enqueue(parsed.source, parsed.index, filename);
    });
  }

  async stop(onProgress?: DrainProgressCallback, beforeChunk?: BeforeChunkCallback) {
    this.stopped = true;
    this.drainMode = true;
    this.drainProgressCb = onProgress ?? null;
    this.drainBeforeChunk = beforeChunk ?? null;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await this.rescan();
    await this.drainQueue();
  }

  // Close without draining — for the 'n' path where a detached finalizer takes over.
  async close(): Promise<void> {
    this.stopped = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  private async rescan() {
    if (!existsSync(this.session.sessionDir)) return;
    const files = await readdir(this.session.sessionDir);
    for (const f of files) {
      const parsed = parseChunkFilename(f);
      if (!parsed) continue;
      const key = `${parsed.source}-${String(parsed.index).padStart(3, "0")}`;
      if (this.isProcessed(key)) continue;
      this.enqueue(parsed.source, parsed.index, f);
    }
  }

  private isProcessed(key: string): boolean {
    return this.session.processedChunks.some(
      (c) => `${c.source}-${String(c.index).padStart(3, "0")}` === key && c.status === "done"
    );
  }

  private enqueue(source: "mic" | "sys", index: number, wav: string) {
    const key = `${source}-${String(index).padStart(3, "0")}`;
    if (this.isProcessed(key)) return;
    if (this.queue.some((q) => q.source === source && q.index === index)) return;
    this.queue.push({ source, index, wav });
    this.queue.sort((a, b) => {
      if (a.index !== b.index) return a.index - b.index;
      return a.source === "mic" ? -1 : 1;
    });
    if (!this.drainMode) {
      this.processNext();
    }
  }

  private async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const trackProgress = this.drainMode ? this.drainProgressCb : null;
    const beforeChunk = this.drainMode ? this.drainBeforeChunk : null;

    const item = this.queue.shift()!;
    const wavPath = join(this.session.sessionDir, item.wav);

    if (!existsSync(wavPath)) {
      this.processing = false;
      if (trackProgress) {
        this.drainTotal--;
        trackProgress({ done: this.completedDuringDrain, total: this.drainTotal });
      }
      this.processNext();
      return;
    }

    try {
      await beforeChunk?.();

      const config = loadConfig();

      if (this.healthMonitor) {
        const metrics = await analyzeWavFile(wavPath);
        const warning = this.healthMonitor.recordChunk(item.source, item.index, metrics);
        if (warning && this.onHealthWarning) {
          this.onHealthWarning(warning);
        }

        this.healthCheckCounter++;
        if (this.healthCheckCounter % 4 === 0) {
          const micWarning = this.healthMonitor.checkMicMissing();
          if (micWarning && this.onHealthWarning) {
            this.onHealthWarning(micWarning);
          }
        }
      }

      const result = await transcribeChunk(wavPath, config, item.index, item.source, {
        pass: "live",
      });
      const key = `${result.source}-${String(result.chunkIndex).padStart(3, "0")}`;
      this.results.set(key, result.text);

      this.session.processedChunks.push({
        source: item.source,
        index: item.index,
        wav: item.wav,
        status: "done",
      });

      if (this.onTranscribed) {
        this.onTranscribed(item.source, item.index, result.text);
      }

      // Append to entries.jsonl for reliable recovery
      const timestamp = new Date().toISOString().split("T")[1].slice(0, 8);
      if (result.metrics) {
        await appendEntryRecord(this.session.sessionDir, {
          source: result.source,
          index: result.chunkIndex,
          timestamp,
          text: result.text,
          rmsDb: result.metrics.rmsDb,
        }).catch(() => {});
      }

      await writeSession(this.session).catch(() => {});
    } catch (err) {
      this.session.processedChunks.push({
        source: item.source,
        index: item.index,
        wav: item.wav,
        status: "failed",
      });
      this.session.lastError = String(err);
      await writeSession(this.session).catch(() => {});

      if (this.onFailure) {
        this.onFailure(item.source, item.index, String(err));
      }
    }

    if (trackProgress) {
      this.completedDuringDrain++;
      trackProgress({ done: this.completedDuringDrain, total: this.drainTotal });
    }

    this.processing = false;
    if (this.queue.length > 0) {
      this.processNext();
    }
  }

  async drainQueue(): Promise<void> {
    this.completedDuringDrain = this.session.processedChunks.filter((c) => c.status === "done").length;
    this.drainTotal = this.completedDuringDrain + this.queue.length;
    this.drainProgressCb?.({ done: this.completedDuringDrain, total: this.drainTotal });
    while (this.processing || this.queue.length > 0) {
      if (!this.processing && this.queue.length > 0) {
        this.processNext();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  getStats() {
    const micDone = this.session.processedChunks.filter((c) => c.source === "mic" && c.status === "done").length;
    const sysDone = this.session.processedChunks.filter((c) => c.source === "sys" && c.status === "done").length;
    const totalDone = micDone + sysDone;
    return { micDone, sysDone, totalDone, queueLength: this.queue.length };
  }

  getSession(): Session {
    return this.session;
  }
}
