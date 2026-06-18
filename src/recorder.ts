import chalk from "chalk";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Session, Config, TranscriptEntry } from "./types.js";
import { Pipeline } from "./pipeline.js";
import { appendEntry, makeHeader, chunkToTimestamp } from "./assembler.js";
import { runOpencodeQuestion } from "./opencode.js";
import { runTagPicker, writeMetaFile } from "./tags.js";
import { parseCaptureLine } from "./capture-events.js";
import { writeActiveRecordingLock, clearActiveRecordingLock } from "./locks.js";
import { getCaptureBinPath, writeAtomic } from "./storage.js";
import { join } from "node:path";

export interface RecorderOptions {
  silenceTimeout: number;
  maxDurationMinutes: number;
  noTextTimeoutMinutes: number;
  voiceProcessing: boolean;
  headless: boolean;
}

export class Recorder {
  private session: Session;
  private config: Config;
  private opts: RecorderOptions;
  private pipeline: Pipeline;
  private captureProcess: ChildProcess | null = null;
  private micChunks = 0;
  private sysChunks = 0;
  private autoStopReason: "max_duration" | "no_text_timeout" | null = null;
  private shuttingDown = false;
  private statusInterval: ReturnType<typeof setInterval> | null = null;
  private opencodeRunning = false;
  private paused = false;
  private pausedAccumMs = 0;
  private pauseStartedAt: number | null = null;
  private readonly startedAt: Date;
  private readonly outputFile: string;
  private readonly header: string;
  private startNextMeeting = false;
  private resolveRun: (() => void) | null = null;
  private sigintHandler: (() => void) | null = null;
  private sigtermHandler: (() => void) | null = null;
  private stdinDataHandler: ((data: Buffer) => void) | null = null;

  constructor(session: Session, config: Config, opts: RecorderOptions) {
    this.session = session;
    this.config = config;
    this.opts = opts;
    this.startedAt = new Date(session.startedAt);
    this.outputFile = session.outputFile;
    this.header = makeHeader(session.title, session.startedAt);
    this.pipeline = new Pipeline(session);
  }

  async run(): Promise<{ startNextMeeting: boolean }> {
    this.initPipeline();
    this.startCapture();

    await new Promise<void>((resolve) => {
      this.resolveRun = resolve;
      this.captureProcess?.on("exit", () => {
        // Only auto-trigger if capture exited on its own (not via our stopCapture).
        if (!this.shuttingDown) {
          this.shutdown().then(resolve);
        }
        // If shuttingDown, doStop*/nextMeeting will call resolveRun themselves.
      });
    });

    return { startNextMeeting: this.startNextMeeting };
  }

  private initPipeline(): void {
    this.pipeline.setTranscribeCallback((source, index, text) => {
      if (source === "mic") this.micChunks = Math.max(this.micChunks, index);
      else this.sysChunks = Math.max(this.sysChunks, index);

      const chunkOffset = index * this.session.chunkDurationSeconds;
      this.session.latestProcessedOffsetSeconds = Math.max(
        this.session.latestProcessedOffsetSeconds,
        chunkOffset,
      );

      if (text && text.trim()) {
        this.session.hasMeaningfulText = true;
        this.session.lastMeaningfulTextAtOffsetSeconds = chunkOffset;
      }

      if (!text) return;

      const timestamp = chunkToTimestamp(
        index,
        this.session.chunkDurationSeconds,
        this.session.startedAt,
      );
      const entry: TranscriptEntry = { source, chunkIndex: index, timestamp, text };
      appendEntry(this.outputFile, this.header, entry).catch(() => {});
    });

    this.pipeline.initHealthMonitor(this.config);
    this.pipeline.setHealthWarningCallback((warning) => {
      process.stdout.write("\n");
      console.log(chalk.yellow(`[health] ${warning.message}`));
    });

    this.pipeline.start();
    this.setupSignalHandlers();
  }

  private startCapture(): void {
    const captureBin = getCaptureBinPath();
    const captureArgs = [
      "--output-dir", this.session.sessionDir,
      "--chunk-duration", String(this.config.chunkDurationSeconds),
      "--mode", this.session.mode,
      "--silence-timeout", String(this.opts.silenceTimeout),
    ];
    if (this.opts.voiceProcessing) captureArgs.push("--voice-processing");

    try {
      this.captureProcess = spawn(captureBin, captureArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.session.capturePid = this.captureProcess.pid ?? null;
      writeAtomic(
        join(this.session.sessionDir, "session.json"),
        JSON.stringify(this.session, null, 2),
      );
      writeActiveRecordingLock(this.session);

      this.captureProcess.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          const parsed = parseCaptureLine(line);
          if (parsed) {
            if (parsed.type === "json") {
              const ev = parsed.event;
              if (ev.event === "chunk_finalized") {
                if ((ev as any).source === "mic") this.micChunks++;
                else this.sysChunks++;
              } else if (ev.level === "warning" || ev.level === "error") {
                process.stdout.write("\n");
                console.log(chalk.gray(`[capture] ${(ev as any).message || ev.event}`));
              }
            } else {
              if (parsed.finalized.source === "mic") this.micChunks++;
              else this.sysChunks++;
            }
          } else if (
            line.includes("failed") ||
            line.includes("timeout") ||
            line.includes("stopped") ||
            line.includes("error")
          ) {
            process.stdout.write("\n");
            console.log(chalk.gray(`[capture] ${line}`));
          }
        }
      });

      this.captureProcess.on("exit", (code) => {
        if (code && code !== 0) {
          console.log(chalk.red(`AudioCapture exited with code ${code}`));
        }
      });
    } catch (err) {
      console.log(chalk.red(`Failed to start AudioCapture: ${err}`));
      process.exit(1);
    }
  }

  private async stopCapture(forceAfterMs = 5000): Promise<void> {
    if (!this.captureProcess || this.captureProcess.killed) return;
    this.captureProcess.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.captureProcess?.kill("SIGKILL");
        resolve();
      }, forceAfterMs);
      this.captureProcess?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async stopRecording(): Promise<void> {
    this.stopStatus();
    process.stdout.write("\n");
    console.log(chalk.yellow("Stopping recording..."));

    this.session.status = "stopped";
    await writeAtomic(
      join(this.session.sessionDir, "session.json"),
      JSON.stringify(this.session, null, 2),
    );

    await this.stopCapture();
    clearActiveRecordingLock();
  }

  private cleanup(): void {
    if (this.sigintHandler) {
      process.removeListener("SIGINT", this.sigintHandler);
      this.sigintHandler = null;
    }
    if (this.sigtermHandler) {
      process.removeListener("SIGTERM", this.sigtermHandler);
      this.sigtermHandler = null;
    }
    if (this.stdinDataHandler && process.stdin.isTTY) {
      process.stdin.removeListener("data", this.stdinDataHandler);
      this.stdinDataHandler = null;
      process.stdin.setRawMode(false);
    }
    this.pipeline.close().catch(() => {});
  }

  private async promptTags(): Promise<void> {
    if (this.opts.headless || !process.stdin.isTTY) return;
    try {
      const tags = await runTagPicker(this.session, { note: "Final transcription running in background…" });
      if (tags.length > 0) {
        this.session.tags = tags;
        await writeMetaFile(this.session, tags);
        console.log(chalk.green(`Tags: ${tags.join(", ")}`));
      } else {
        console.log(chalk.gray("(no tags added)"));
      }
    } catch {
      process.stdout.write(chalk.gray("(tag picker skipped)\n"));
    }
  }

  private spawnBackgroundFinalizer(): void {
    const binPath = process.argv[1];
    const child = spawn(process.execPath, [binPath, "finalize", this.session.sessionDir], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  // q / SIGINT / auto-stop: background everything, return to shell.
  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    try {
      await this.stopRecording();
      if (this.autoStopReason) {
        const label = this.autoStopReason === "max_duration" ? "max duration" : "no text timeout";
        console.log(chalk.yellow(`Auto-stopped (${label}).`));
      }
      await this.promptTags();
      this.spawnBackgroundFinalizer();
      console.log(chalk.green(`Finalizer started in background (meet status to check)`));
      console.log(chalk.gray(`Transcript: ${this.outputFile}`));
      process.exit(0);
    } catch (err) {
      console.log(chalk.red(`Failed: ${formatError(err)}`));
      console.log(chalk.yellow(`Recoverable session: ${this.session.sessionDir}`));
      process.exit(1);
    }
  }

  // s: drain small model inline, then background big-model pass.
  private async stopAndFinalizeForeground(): Promise<void> {
    if (this.opencodeRunning || this.shuttingDown) return;
    this.shuttingDown = true;

    try {
      await this.stopRecording();

      console.log(chalk.yellow("Finishing live transcription..."));
      let latestMsg = "";
      const progressInterval = setInterval(() => {
        process.stdout.write(`\r${chalk.gray(latestMsg)}  `);
      }, 200);
      try {
        await this.pipeline.stop((progress) => {
          latestMsg = `Live pass: ${progress.done}/${progress.total}`;
        });
      } finally {
        clearInterval(progressInterval);
        process.stdout.write("\n");
      }

      await this.promptTags();
      this.spawnBackgroundFinalizer();
      console.log(chalk.green(`Final pass running in background (meet status to check)`));
      console.log(chalk.gray(`Transcript: ${this.outputFile}`));
      process.exit(0);
    } catch (err) {
      console.log(chalk.red(`Failed: ${formatError(err)}`));
      console.log(chalk.yellow(`Recoverable session: ${this.session.sessionDir}`));
      process.exit(1);
    }
  }

  // n: background everything, clean up listeners, return to start next meeting.
  private async nextMeeting(): Promise<void> {
    if (this.opencodeRunning || this.shuttingDown) return;
    this.shuttingDown = true;
    this.startNextMeeting = true;

    try {
      await this.stopRecording();
      this.spawnBackgroundFinalizer();
      console.log(chalk.green(`Finalizer running in background (meet status to check)`));
    } catch (err) {
      console.log(chalk.red(`Failed: ${formatError(err)}`));
      this.startNextMeeting = false;
    } finally {
      this.cleanup();
      this.resolveRun?.();
    }
  }

  private effectiveElapsedMs(): number {
    return Date.now() - this.startedAt.getTime() - this.pausedAccumMs - (this.paused ? Date.now() - (this.pauseStartedAt ?? Date.now()) : 0);
  }

  private checkAutoStop(): void {
    if (this.shuttingDown || this.autoStopReason) return;

    const elapsedSec = this.effectiveElapsedMs() / 1000;

    if (
      this.opts.maxDurationMinutes > 0 &&
      elapsedSec >= this.opts.maxDurationMinutes * 60
    ) {
      this.autoStopReason = "max_duration";
      this.session.autoStopReason = "max_duration";
      console.log(
        chalk.yellow(
          `Max duration reached: ${this.opts.maxDurationMinutes} minutes. Finalizing...`,
        ),
      );
      void this.shutdown();
      return;
    }

    if (
      this.opts.noTextTimeoutMinutes > 0 &&
      this.session.hasMeaningfulText &&
      this.session.lastMeaningfulTextAtOffsetSeconds !== null &&
      this.session.latestProcessedOffsetSeconds -
        this.session.lastMeaningfulTextAtOffsetSeconds >=
        this.opts.noTextTimeoutMinutes * 60
    ) {
      this.autoStopReason = "no_text_timeout";
      this.session.autoStopReason = "no_text_timeout";
      console.log(
        chalk.yellow(
          `No meaningful transcript for ${this.opts.noTextTimeoutMinutes} processed minutes. Finalizing...`,
        ),
      );
      void this.shutdown();
    }
  }

  private stopStatus(): void {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = null;
    }
  }

  private startStatus(): void {
    if (this.statusInterval) return;
    this.statusInterval = setInterval(() => {
      const stats = this.pipeline.getStats();
      const elapsed = Math.floor(this.effectiveElapsedMs() / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const secs = String(elapsed % 60).padStart(2, "0");
      const now = new Date().toLocaleTimeString("ru-RU", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const lagSec =
        (this.micChunks + this.sysChunks - stats.totalDone) *
        this.config.chunkDurationSeconds;
      const lagStr = lagSec > 0 ? `lag ~${lagSec}s` : "up to date";

      let capStr = "";
      if (this.opts.maxDurationMinutes > 0) {
        const remaining = Math.max(
          0,
          this.opts.maxDurationMinutes * 60 - elapsed,
        );
        capStr = ` | cap: ${formatDuration(remaining)}`;
      }

      let noTextStr = "";
      if (this.opts.noTextTimeoutMinutes > 0) {
        if (!this.session.hasMeaningfulText) {
          noTextStr = " | no text: waiting";
        } else {
          const gapSec =
            this.session.latestProcessedOffsetSeconds -
            (this.session.lastMeaningfulTextAtOffsetSeconds ?? 0);
          const remaining = Math.max(
            0,
            this.opts.noTextTimeoutMinutes * 60 - gapSec,
          );
          noTextStr = ` | no text: ${formatDuration(remaining)}`;
        }
      }

      const status = this.paused ? chalk.yellow("PAUSED") : chalk.cyan(`Recording ${mins}:${secs}`);
      process.stdout.write(
        `\r${status} | chunks: mic ${this.micChunks}, sys ${this.sysChunks} | transcribed: ${stats.totalDone} | ${lagStr}${capStr}${noTextStr} | ${now}  `,
      );

      this.checkAutoStop();
    }, 5000);
  }

  private async togglePause(): Promise<void> {
    if (this.shuttingDown || this.opencodeRunning) return;

    if (this.paused) {
      this.captureProcess?.kill("SIGUSR2");
      this.pausedAccumMs += Date.now() - (this.pauseStartedAt ?? Date.now());
      this.pauseStartedAt = null;
      this.paused = false;
      this.session.status = "recording";
      process.stdout.write("\n");
      console.log(chalk.green("▶ Resumed"));
    } else {
      this.captureProcess?.kill("SIGUSR1");
      this.paused = true;
      this.pauseStartedAt = Date.now();
      this.session.status = "paused";
      process.stdout.write("\n");
      console.log(chalk.yellow("⏸ Paused"));
    }

    await writeAtomic(
      join(this.session.sessionDir, "session.json"),
      JSON.stringify(this.session, null, 2),
    );
  }

  private extendCap(): void {
    if (this.shuttingDown) return;
    const EXTEND_MINUTES = 15;
    if (this.opts.maxDurationMinutes > 0) {
      this.opts.maxDurationMinutes += EXTEND_MINUTES;
    } else {
      const currentMinutes = Math.ceil(this.effectiveElapsedMs() / 60000);
      this.opts.maxDurationMinutes = currentMinutes + EXTEND_MINUTES;
    }
    console.log(chalk.green(`Cap extended +${EXTEND_MINUTES}m → now ${this.opts.maxDurationMinutes}m`));
  }

  private askQuestion(): void {
    if (this.opencodeRunning || this.shuttingDown) return;
    this.opencodeRunning = true;
    this.stopStatus();
    process.stdout.write("\n");
    process.stdin.setRawMode(false);
    process.stdout.write(chalk.cyan("Question for opencode: "));

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("", async (question: string) => {
      rl.close();

      const q = question.trim();
      if (!q) {
        process.stdout.write(chalk.gray("(cancelled)\n"));
        this.opencodeRunning = false;
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        this.startStatus();
        return;
      }

      process.stdout.write(chalk.gray("Waiting for opencode (up to 60s)...\n"));
      if (process.stdin.isTTY) process.stdin.setRawMode(true);

      try {
        const result = await runOpencodeQuestion(
          this.config,
          this.outputFile,
          this.session.title,
          q,
        );
        process.stdout.write("\n");
        console.log(chalk.bold("--- Answer ---"));
        console.log(result);
        console.log(chalk.bold("--- End answer ---\n"));
      } catch (err) {
        console.log(chalk.red(`Question failed: ${formatError(err)}`));
      } finally {
        this.opencodeRunning = false;
        this.startStatus();
      }
    });
  }

  private setupSignalHandlers(): void {
    this.sigintHandler = () => this.shutdown();
    this.sigtermHandler = () => this.shutdown();
    process.on("SIGINT", this.sigintHandler);
    process.on("SIGTERM", this.sigtermHandler);

    process.on("SIGUSR1", () => {
      if (!this.paused) void this.togglePause();
    });
    process.on("SIGUSR2", () => {
      if (this.paused) void this.togglePause();
    });
    process.on("SIGWINCH", () => this.extendCap());

    if (!this.opts.headless && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      this.stdinDataHandler = (data: Buffer) => {
        const key = data.toString();
        if (key === "q" || key === "Q") {
          void this.shutdown();
        } else if (key === "s" || key === "S") {
          void this.stopAndFinalizeForeground();
        } else if (key === "n" || key === "N") {
          void this.nextMeeting();
        } else if (key === "a" || key === "A") {
          this.askQuestion();
        } else if (key === "p" || key === "P") {
          void this.togglePause();
        } else if (key === "e" || key === "E") {
          this.extendCap();
        }
      };
      process.stdin.on("data", this.stdinDataHandler);
    }

    this.startStatus();
  }
}

function formatDuration(sec: number): string {
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function formatError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.length <= 200) return msg;
  return msg.slice(0, 200).trim() + "...";
}
