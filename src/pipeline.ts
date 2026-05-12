import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import chokidar from "chokidar";
import type { Session, Config } from "./types.js";
import { writeSession, loadConfig } from "./storage.js";
import { transcribeChunk, parseChunkFilename } from "./transcriber.js";

type TranscribeCallback = (source: "mic" | "sys", index: number, text: string) => void;

export class Pipeline {
  private session: Session;
  private watcher: chokidar.FSWatcher | null = null;
  private queue: Array<{ source: "mic" | "sys"; index: number; wav: string }> = [];
  private processing = false;
  private results = new Map<string, string>();
  private onTranscribed: TranscribeCallback | null = null;
  private stopped = false;

  constructor(session: Session) {
    this.session = session;
  }

  setTranscribeCallback(cb: TranscribeCallback) {
    this.onTranscribed = cb;
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

  async stop() {
    this.stopped = true;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await this.rescan();
    await this.drainQueue();
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
    this.processNext();
  }

  private async processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const item = this.queue.shift()!;
    const wavPath = join(this.session.sessionDir, item.wav);

    if (!existsSync(wavPath)) {
      this.processing = false;
      this.processNext();
      return;
    }

    try {
      const config = loadConfig();
      const result = await transcribeChunk(wavPath, config, item.index, item.source);
      const key = `${result.source}-${String(result.chunkIndex).padStart(3, "0")}`;
      this.results.set(key, result.text);

      this.session.processedChunks.push({
        source: item.source,
        index: item.index,
        wav: item.wav,
        status: "done",
      });

      await writeSession(this.session);

      if (this.onTranscribed) {
        this.onTranscribed(item.source, item.index, result.text);
      }
    } catch (err) {
      this.session.processedChunks.push({
        source: item.source,
        index: item.index,
        wav: item.wav,
        status: "failed",
      });
      this.session.lastError = String(err);
      await writeSession(this.session);
    }

    this.processing = false;
    if (!this.stopped) {
      this.processNext();
    }
  }

  async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      await new Promise<void>((resolve) => {
        this.processing = false;
        this.processNext();
        const check = setInterval(() => {
          if (!this.processing) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
    }
  }

  getStats() {
    const micDone = this.session.processedChunks.filter((c) => c.source === "mic" && c.status === "done").length;
    const sysDone = this.session.processedChunks.filter((c) => c.source === "sys" && c.status === "done").length;
    const totalDone = micDone + sysDone;
    return { micDone, sysDone, totalDone, queueLength: this.queue.length };
  }
}
