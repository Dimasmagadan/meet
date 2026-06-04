import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getOutputPath, getOutputDir, ensureDir, getCaptureBinPath, findStaleSessions, expandPath, writeAtomic } from "./storage.js";
import { Pipeline } from "./pipeline.js";
import { appendEntry, makeHeader, chunkToTimestamp } from "./assembler.js";
import { runOpencodeQuestion } from "./opencode.js";
import { runTagPicker, writeMetaFile } from "./tags.js";
import { parseCaptureLine } from "./capture-events.js";
import { finalizeSession } from "./finalize.js";
import { showStatus } from "./status.js";
import { writeActiveRecordingLock, clearActiveRecordingLock } from "./locks.js";
import { transcribeImport, type ImportOptions } from "./import.js";
import { spawn, ChildProcess, execSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { nanoid } from "nanoid";
import type { Session, Config, TranscriptEntry } from "./types.js";
import { analyzeWavFile } from "./audio-metrics.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("meet")
    .description("Local meeting transcription tool")
    .version("0.1.0");

  program
    .command("start")
    .description("Start a foreground recording session")
    .argument("<title>", "Meeting title")
    .option("--mic", "Mic-only mode (no system audio)")
    .option("--silence <seconds>", "Silence timeout for audio capture (0 = disabled)", parseInt, 0)
    .option("--max-duration <minutes>", "Auto-stop after N minutes (0 = disabled)", parseInt)
    .option("--no-text-timeout <minutes>", "Auto-stop after N processed minutes without transcript (0 = disabled)", parseInt)
    .option("--voice-processing", "Enable VoiceProcessing IO echo cancellation (default: off)")
    .action(async (title: string, opts: { mic?: boolean; silence?: number; maxDuration?: number; noTextTimeout?: number; voiceProcessing?: boolean }) => {
      const mode = opts.mic ? "mic" as const : "full" as const;
      await startSession(title, mode, opts.silence ?? 0, opts.maxDuration, opts.noTextTimeout, opts.voiceProcessing);
    });

  program
    .command("setup")
    .description("Check dependencies and configuration")
    .action(async () => {
      await runSetup();
    });

  program
    .command("doctor")
    .description("Run a short capture health check")
    .argument("[target]", "mic or full", "mic")
    .action(async (target: string) => {
      const mode = target === "full" ? "full" as const : "mic" as const;
      await runDoctor(mode);
    });

  program
    .command("list")
    .description("List past meetings")
    .action(async () => {
      await listMeetings();
    });

  program
    .command("finalize")
    .description("Finalize a stopped recording session")
    .argument("<sessionDir>", "Session directory path")
    .option("--background", "Run finalization in background")
    .action(async (sessionDir: string, opts: { background?: boolean }) => {
      if (opts.background) {
        await spawnBackgroundFinalizer(sessionDir);
      } else {
        await runForegroundFinalize(sessionDir);
      }
    });

  program
    .command("status")
    .description("Show active recording and finalization jobs")
    .action(() => {
      showStatus();
    });

  program
    .command("transcribe")
    .description("Transcribe audio or video files")
    .argument("<files...>", "Audio/video files to transcribe")
    .option("--title <title>", "Meeting title (single file only)")
    .option("--model <model>", "Model: small or medium", "medium")
    .option("--no-index", "Skip index generation")
    .option("--date <date>", "Recording date (YYYY-MM-DD)")
    .action(async (files: string[], opts: { title?: string; model?: string; index?: boolean; date?: string }) => {
      const importOpts: ImportOptions = {
        title: opts.title,
        model: opts.model === "small" ? "small" : "medium",
        noIndex: opts.index === false,
        date: opts.date,
      };
      await transcribeImport(files, importOpts);
    });

  return program;
}

async function startSession(title: string, mode: "full" | "mic", silenceTimeout: number = 0, maxDurationMinutes?: number, noTextTimeoutMinutes?: number, voiceProcessing?: boolean) {
  const config = loadConfig();
  const effectiveVP = voiceProcessing ?? config.micVoiceProcessing;
  const effectiveMaxDuration = maxDurationMinutes ?? config.maxDurationMinutes;
  const effectiveNoTextTimeout = noTextTimeoutMinutes ?? config.noTextTimeoutMinutes;

  const stale = findStaleSessions();
  if (stale.length > 0) {
    console.log(chalk.yellow("Warning: stale sessions found:"));
    for (const s of stale) {
      console.log(chalk.yellow(`  ${s}`));
    }
    console.log(chalk.yellow("  Run manually: meet recover (post-MVP)"));
    console.log();
  }

  const setupErrors = checkSetup(config, mode);
  if (setupErrors.length > 0) {
    for (const e of setupErrors) {
      console.log(chalk.red(e));
    }
    process.exit(1);
  }

  const id = nanoid(8);
  const sessionDir = `/tmp/meet-${id}`;
  await mkdir(sessionDir, { recursive: true });

  const startedAt = new Date();
  const meetingDir = getOutputDir(config, title, startedAt);
  const outputFile = getOutputPath(config, title, startedAt);
  const captureBin = getCaptureBinPath();

  await mkdir(meetingDir, { recursive: true });

  const header = makeHeader(title, startedAt.toISOString());
  await writeFile(outputFile, header, "utf-8");

  const session: Session = {
    id,
    title,
    mode,
    startedAt: startedAt.toISOString(),
    chunkDurationSeconds: config.chunkDurationSeconds,
    sessionDir,
    outputFile,
    capturePid: null,
    status: "recording",
    processedChunks: [],
    lastError: null,
    autoStopReason: null,
    latestProcessedOffsetSeconds: 0,
    lastMeaningfulTextAtOffsetSeconds: null,
    hasMeaningfulText: false,
    tags: [],
  };

  await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

  console.log(chalk.gray("Press q to stop, s to stop (foreground), a to ask opencode\n"));

  const pipeline = new Pipeline(session);
  let micChunks = 0;
  let sysChunks = 0;

  pipeline.setTranscribeCallback((source, index, text) => {
    if (source === "mic") micChunks = Math.max(micChunks, index);
    else sysChunks = Math.max(sysChunks, index);

    const chunkOffset = index * session.chunkDurationSeconds;
    session.latestProcessedOffsetSeconds = Math.max(session.latestProcessedOffsetSeconds, chunkOffset);

    if (text && text.trim()) {
      session.hasMeaningfulText = true;
      session.lastMeaningfulTextAtOffsetSeconds = chunkOffset;
    }

    if (!text) return;

    const timestamp = chunkToTimestamp(index, session.chunkDurationSeconds, session.startedAt);
    const entry: TranscriptEntry = { source, chunkIndex: index, timestamp, text };
    appendEntry(outputFile, header, entry).catch(() => {});
  });

  pipeline.initHealthMonitor(config);
  pipeline.setHealthWarningCallback((warning) => {
    process.stdout.write("\n");
    console.log(chalk.yellow(`[health] ${warning.message}`));
  });

  pipeline.start();

  const captureArgs = [
    "--output-dir", sessionDir,
    "--chunk-duration", String(config.chunkDurationSeconds),
    "--mode", mode,
    "--silence-timeout", String(silenceTimeout),
  ];
  if (effectiveVP) captureArgs.push("--voice-processing");
  let captureProcess: ChildProcess | null = null;

  try {
    captureProcess = spawn(captureBin, captureArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    session.capturePid = captureProcess.pid ?? null;
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));
    writeActiveRecordingLock(session);

    captureProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const parsed = parseCaptureLine(line);
        if (parsed) {
          if (parsed.type === "json") {
            const ev = parsed.event;
            if (ev.event === "chunk_finalized") {
              if ((ev as any).source === "mic") micChunks++;
              else sysChunks++;
            } else if (ev.level === "warning" || ev.level === "error") {
              process.stdout.write("\n");
              console.log(chalk.gray(`[capture] ${(ev as any).message || ev.event}`));
            }
          } else {
            if (parsed.finalized.source === "mic") micChunks++;
            else sysChunks++;
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

    captureProcess.on("exit", (code) => {
      if (code && code !== 0) {
        console.log(chalk.red(`AudioCapture exited with code ${code}`));
      }
    });

  } catch (err) {
    console.log(chalk.red(`Failed to start AudioCapture: ${err}`));
    process.exit(1);
  }

  type AutoStopReason = "max_duration" | "no_text_timeout";

  let autoStopReason: AutoStopReason | null = null;
  let shuttingDown = false;
  let statusInterval: ReturnType<typeof setInterval> | null = null;

  const stopStatus = () => {
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
  };

  const stopCapture = async (forceAfterMs = 5000) => {
    if (!captureProcess || captureProcess.killed) return;
    captureProcess.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        captureProcess?.kill("SIGKILL");
        resolve();
      }, forceAfterMs);
      captureProcess?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const stopRecording = async () => {
    stopStatus();
    process.stdout.write("\n");
    console.log(chalk.yellow("Stopping recording..."));

    session.status = "stopped";
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

    await stopCapture();
    clearActiveRecordingLock();
  };

  const promptTags = async (sess: Session) => {
    if (!process.stdin.isTTY) return;
    try {
      const tags = await runTagPicker(sess);
      if (tags.length > 0) {
        const latestSession = await readFile(join(sessionDir, "session.json"), "utf-8").then(
          (d) => JSON.parse(d) as Session
        ).catch(() => sess);
        latestSession.tags = tags;
        sess.tags = tags;
        await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(latestSession, null, 2));
        await writeMetaFile(latestSession, tags);
        console.log(chalk.green(`Tags: ${tags.join(", ")}`));
      } else {
        console.log(chalk.gray("(no tags added)"));
      }
    } catch {
      process.stdout.write(chalk.gray("(tag picker skipped)\n"));
    }
  };

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      await stopRecording();
      await promptTags(session);

      session.status = "queued";
      await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

      const reasonStr = autoStopReason
        ? ` (${autoStopReason === "max_duration" ? "max duration" : "no text timeout"})`
        : "";
      console.log(chalk.green(`Finalization queued in background: ${sessionDir}${reasonStr}`));
      console.log(chalk.gray(`Progress: meet status`));
      console.log(chalk.gray(`Transcript: ${outputFile}`));

      const binPath = process.argv[1];
      const child = spawn(process.execPath, [binPath, "finalize", sessionDir], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      process.exit(0);
    } catch (err) {
      stopStatus();
      await stopCapture(2000).catch(() => {});
      console.log(chalk.red(`Shutdown failed: ${formatError(err)}`));
      console.log(chalk.yellow(`Recoverable session: ${sessionDir}`));
      console.log(chalk.yellow(`Partial transcript: ${outputFile}`));
      process.exit(1);
    }
  };

  const checkAutoStop = () => {
    if (shuttingDown || autoStopReason) return;

    const elapsedSec = (Date.now() - startedAt.getTime()) / 1000;

    if (effectiveMaxDuration > 0 && elapsedSec >= effectiveMaxDuration * 60) {
      autoStopReason = "max_duration";
      session.autoStopReason = "max_duration";
      console.log(chalk.yellow(`Max duration reached: ${effectiveMaxDuration} minutes. Finalizing...`));
      void shutdown();
      return;
    }

    if (
      effectiveNoTextTimeout > 0 &&
      session.hasMeaningfulText &&
      session.lastMeaningfulTextAtOffsetSeconds !== null &&
      session.latestProcessedOffsetSeconds - session.lastMeaningfulTextAtOffsetSeconds >= effectiveNoTextTimeout * 60
    ) {
      autoStopReason = "no_text_timeout";
      session.autoStopReason = "no_text_timeout";
      console.log(chalk.yellow(`No meaningful transcript for ${effectiveNoTextTimeout} processed minutes. Finalizing...`));
      void shutdown();
      return;
    }
  };

  const formatDuration = (sec: number): string => {
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${m}:${s}`;
  };

  const startStatus = () => {
    if (statusInterval) return;
    statusInterval = setInterval(() => {
      const stats = pipeline.getStats();
      const elapsed = Math.floor((Date.now() - startedAt.getTime()) / 1000);
      const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const secs = String(elapsed % 60).padStart(2, "0");
      const now = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      const lagSec = (micChunks + sysChunks - stats.totalDone) * config.chunkDurationSeconds;
      const lagStr = lagSec > 0 ? `lag ~${lagSec}s` : "up to date";

      let capStr = "";
      if (effectiveMaxDuration > 0) {
        const remaining = Math.max(0, effectiveMaxDuration * 60 - elapsed);
        capStr = ` | cap: ${formatDuration(remaining)}`;
      }

      let noTextStr = "";
      if (effectiveNoTextTimeout > 0) {
        if (!session.hasMeaningfulText) {
          noTextStr = " | no text: waiting";
        } else {
          const gapSec = session.latestProcessedOffsetSeconds - (session.lastMeaningfulTextAtOffsetSeconds ?? 0);
          const remaining = Math.max(0, effectiveNoTextTimeout * 60 - gapSec);
          noTextStr = ` | no text: ${formatDuration(remaining)}`;
        }
      }

      process.stdout.write(
        `\r${chalk.cyan(`Recording ${mins}:${secs}`)} | chunks: mic ${micChunks}, sys ${sysChunks} | transcribed: ${stats.totalDone} | ${lagStr}${capStr}${noTextStr} | ${now}  `
      );

      checkAutoStop();
    }, 5000);
  };

  startStatus();

  const stopAndIndex = async () => {
    if (opencodeRunning || shuttingDown) return;
    shuttingDown = true;

    try {
      await stopRecording();
      await promptTags(session);

      console.log(chalk.yellow("Finalizing..."));
      const result = await finalizeSession(sessionDir, {
        foreground: true,
        pauseForActiveRecording: false,
        onProgress: (msg) => {
          process.stdout.write(`\r${chalk.gray(msg)}  `);
          if (msg.startsWith("Done:") || msg.startsWith("Transcribed")) {
            process.stdout.write("\n");
          }
        },
      });
      for (const w of result.warnings) console.log(chalk.yellow(w));
      const entries = result.entries;

      console.log(chalk.green(`Transcript: ${outputFile}`));
      console.log(chalk.gray(`Transcribed ${entries.length} segments`));

      process.exit(0);
    } catch (err) {
      console.log(chalk.red(`Finalization failed: ${formatError(err)}`));
      process.exit(1);
    }
  };

  let opencodeRunning = false;

  const askQuestion = () => {
    if (opencodeRunning || shuttingDown) return;
    opencodeRunning = true;
    stopStatus();
    process.stdout.write("\n");
    process.stdin.setRawMode(false);
    process.stdout.write(chalk.cyan("Question for opencode: "));

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("", async (question: string) => {
      rl.close();

      const q = question.trim();
      if (!q) {
        process.stdout.write(chalk.gray("(cancelled)\n"));
        opencodeRunning = false;
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        startStatus();
        return;
      }

      process.stdout.write(chalk.gray("Waiting for opencode (up to 60s)...\n"));
      if (process.stdin.isTTY) process.stdin.setRawMode(true);

      try {
        const result = await runOpencodeQuestion(config, outputFile, title, q);
        process.stdout.write("\n");
        console.log(chalk.bold("--- Answer ---"));
        console.log(result);
        console.log(chalk.bold("--- End answer ---\n"));
      } catch (err) {
        console.log(chalk.red(`Question failed: ${formatError(err)}`));
      } finally {
        opencodeRunning = false;
        startStatus();
      }
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => {
      const key = data.toString();
      if (key === "q" || key === "Q") {
        shutdown();
      } else if (key === "s" || key === "S") {
        stopAndIndex();
      } else if (key === "a" || key === "A") {
        askQuestion();
      }
    });
  }

  await new Promise<void>((resolve) => {
    captureProcess?.on("exit", () => {
      if (!shuttingDown) {
        shutdown().then(resolve);
      } else {
        resolve();
      }
    });
  });
}

function formatError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.length <= 200) return msg;
  return msg.slice(0, 200).trim() + "...";
}

function checkSetup(config: Config, mode: string): string[] {
  const errors: string[] = [];

  const commonPaths = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];
  const whisperPath = commonPaths.find((p) => existsSync(p));
  if (!whisperPath) {
    errors.push("whisper-cli not found. Install: brew install whisper-cpp");
  }

  const liveModelPath = expandPath(config.liveModelPath || config.modelPath);
  if (!existsSync(liveModelPath)) {
    errors.push(`Live model not found: ${liveModelPath}. Run: meet setup or scripts/setup.sh`);
  }

  if (config.finalRetranscribe) {
    const finalModelPath = expandPath(config.finalModelPath || config.modelPath);
    if (!existsSync(finalModelPath)) {
      console.log(chalk.yellow(`  Final model not found: ${finalModelPath} (final pass will use live transcript)`));
      console.log(chalk.gray(`    Download: curl -L -o ${finalModelPath} https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin`));
    }
  }

  const captureBin = getCaptureBinPath();
  if (!existsSync(captureBin)) {
    errors.push(`AudioCapture not built: ${captureBin}. Run: cd native/AudioCapture && swift build -c release`);
  }

  return errors;
}

async function runSetup() {
  const config = loadConfig();

  console.log("Checking dependencies...\n");

  let ok = true;

  const commonPaths = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"];
  const whisperPath = commonPaths.find((p) => existsSync(p));
  if (whisperPath) {
    console.log(chalk.green("  whisper-cli: ") + whisperPath);
  } else {
    console.log(chalk.red("  whisper-cli: NOT FOUND"));
    console.log(chalk.gray("    Install: brew install whisper-cpp"));
    ok = false;
  }

  const liveModelPath = expandPath(config.liveModelPath || config.modelPath);
  if (existsSync(liveModelPath)) {
    console.log(chalk.green("  live model: ") + liveModelPath);
  } else {
    console.log(chalk.red("  live model: NOT FOUND"));
    console.log(chalk.gray("    Download: curl -L -o ~/.meet/models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"));
    ok = false;
  }

  if (config.finalRetranscribe) {
    const finalModelPath = expandPath(config.finalModelPath || config.modelPath);
    if (existsSync(finalModelPath)) {
      console.log(chalk.green("  final model: ") + finalModelPath);
    } else {
      console.log(chalk.yellow("  final model: NOT FOUND (final retranscription disabled)"));
      console.log(chalk.gray("    Download: curl -L -o ~/.meet/models/ggml-medium.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"));
    }
  }

  const captureBin = getCaptureBinPath();
  if (existsSync(captureBin)) {
    console.log(chalk.green("  AudioCapture: ") + captureBin);
  } else {
    console.log(chalk.red("  AudioCapture: NOT BUILT"));
    console.log(chalk.gray("    Build: cd native/AudioCapture && swift build -c release"));
    ok = false;
  }

  const outputDir = expandPath(config.outputDir);
  await mkdir(outputDir, { recursive: true });
  console.log(chalk.green("  output dir: ") + outputDir);

  try {
    const opencodePath = execSync("which opencode 2>/dev/null", { encoding: "utf-8" }).trim();
    console.log(chalk.green("  opencode: ") + opencodePath);
  } catch {
    console.log(chalk.yellow("  opencode: NOT FOUND (optional, for s/a hotkeys during recording)"));
    console.log(chalk.gray("    Install: https://opencode.ai"));
  }

  console.log();
  if (ok) {
    console.log(chalk.green("All checks passed. Ready to record."));
  } else {
    console.log(chalk.yellow("Some checks failed. Fix above issues before recording."));
  }
}

async function runDoctor(mode: "mic" | "full") {
  const config = loadConfig();
  const setupErrors = checkSetup(config, mode);
  if (setupErrors.length > 0) {
    for (const e of setupErrors) {
      console.log(chalk.red(e));
    }
    process.exit(1);
  }

  const sessionDir = await mkdtemp(join(tmpdir(), "meet-doctor-"));
  const captureBin = getCaptureBinPath();
  const chunkDurationSeconds = 5;
  const captureArgs = [
    "--output-dir", sessionDir,
    "--chunk-duration", String(chunkDurationSeconds),
    "--mode", mode,
    "--silence-timeout", "0",
  ];

  console.log(chalk.cyan(`Running ${mode} capture doctor...`));
  if (mode === "full") {
    console.log(chalk.gray("Speak into the mic and play meeting/system audio for about 12 seconds."));
  } else {
    console.log(chalk.gray("Speak into the mic for about 12 seconds."));
  }

  const captureProcess = spawn(captureBin, captureArgs, {
    stdio: ["ignore", "ignore", "pipe"],
  });

  captureProcess.stderr?.on("data", () => {});

  await new Promise((resolve) => setTimeout(resolve, 12_000));
  captureProcess.kill("SIGINT");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      captureProcess.kill("SIGKILL");
      resolve();
    }, 5_000);
    captureProcess.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const files = await readdir(sessionDir);
  const micFiles = files.filter((f) => /^mic-\d{3}\.wav$/.test(f)).sort();
  const sysFiles = files.filter((f) => /^sys-\d{3}\.wav$/.test(f)).sort();

  const micMetrics = await Promise.all(micFiles.map((f) => analyzeWavFile(join(sessionDir, f))));
  const sysMetrics = await Promise.all(sysFiles.map((f) => analyzeWavFile(join(sessionDir, f))));

  const loudMic = micMetrics.filter((m) => m.rmsDb >= config.micRmsThresholdDb);
  const loudSys = sysMetrics.filter((m) => m.rmsDb >= config.sysRmsThresholdDb);

  console.log(chalk.gray(`mic chunks: ${micFiles.length}, loud mic chunks: ${loudMic.length}`));
  if (mode === "full") {
    console.log(chalk.gray(`sys chunks: ${sysFiles.length}, loud sys chunks: ${loudSys.length}`));
  }

  let ok = true;
  if (micFiles.length === 0) {
    console.log(chalk.red("Mic capture produced no finalized chunks."));
    ok = false;
  } else if (loudMic.length === 0) {
    console.log(chalk.red("Mic capture produced only silent/near-silent chunks."));
    ok = false;
  }

  if (mode === "full") {
    if (sysFiles.length === 0) {
      console.log(chalk.red("System capture produced no finalized chunks."));
      ok = false;
    } else if (loudSys.length === 0) {
      console.log(chalk.red("System capture produced only silent/near-silent chunks."));
      ok = false;
    }
  }

  if (ok) {
    console.log(chalk.green("Doctor check passed."));
  } else {
    console.log(chalk.yellow(`Artifacts kept for inspection: ${sessionDir}`));
    process.exit(1);
  }

  await rm(sessionDir, { recursive: true, force: true }).catch(() => {});
}

async function runForegroundFinalize(sessionDir: string) {
  console.log(chalk.cyan(`Finalizing: ${sessionDir}`));
  try {
    const result = await finalizeSession(sessionDir, {
      foreground: true,
      pauseForActiveRecording: true,
      onProgress: (msg) => {
        process.stdout.write(`\r${chalk.gray(msg)}  `);
        if (msg.startsWith("Done:") || msg.startsWith("Transcribed")) {
          process.stdout.write("\n");
        }
      },
    });
    for (const w of result.warnings) console.log(chalk.yellow(w));
  } catch (err) {
    console.log(chalk.red(`Finalization failed: ${err instanceof Error ? err.message : String(err)}`));
    console.log(chalk.yellow(`Recoverable session: ${sessionDir}`));
    process.exit(1);
  }
}

async function spawnBackgroundFinalizer(sessionDir: string) {
  const binPath = process.argv[1];
  const child = spawn(process.execPath, [binPath, "finalize", sessionDir], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(chalk.green(`Background finalizer started (pid ${child.pid})`));
  console.log(chalk.gray(`Progress: meet status`));
}

async function listMeetings() {
  const config = loadConfig();
  const outputDir = expandPath(config.outputDir);

  if (!existsSync(outputDir)) {
    console.log("No meetings found.");
    return;
  }

  const { readdir: readdirSync } = await import("node:fs/promises");
  const entries = (await readdirSync(outputDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  if (entries.length === 0) {
    console.log("No meetings found.");
    return;
  }

  for (const name of entries) {
    console.log(`  ${name}`);
  }
}
