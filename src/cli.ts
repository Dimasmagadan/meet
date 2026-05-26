import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getOutputPath, getOutputDir, ensureDir, getCaptureBinPath, findStaleSessions, expandPath, writeAtomic } from "./storage.js";
import { Pipeline } from "./pipeline.js";
import { assembleMarkdown, entriesFromSession, appendEntry, makeHeader, rewriteMarkdown, chunkToTimestamp } from "./assembler.js";
import { runOpencodeIndex, runOpencodeQuestion } from "./opencode.js";
import { runTagPicker, writeMetaFile } from "./tags.js";
import { parseCaptureLine } from "./capture-events.js";
import { spawn, ChildProcess, execSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { nanoid } from "nanoid";
import type { Session, Config, TranscriptEntry } from "./types.js";

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
    .command("list")
    .description("List past meetings")
    .action(async () => {
      await listMeetings();
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

  console.log(chalk.gray("Press q to stop, s to stop + create index, a to ask opencode\n"));

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

  const finalizeSession = async (): Promise<{ finalSession: Session; entries: TranscriptEntry[] }> => {
    stopStatus();
    process.stdout.write("\n");
    console.log(chalk.yellow("Finalizing..."));

    session.status = "finalizing";
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

    await stopCapture();
    await pipeline.stop();

    const finalSession = await readFile(join(sessionDir, "session.json"), "utf-8").then(
      (d) => JSON.parse(d) as Session
    ).catch(() => session);

    const results = pipeline.getResults();
    const entries = entriesFromSession(finalSession, results);

    if (entries.length > 0) {
      await rewriteMarkdown(outputFile, title, finalSession.startedAt, entries);
    }

    finalSession.status = "done";
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(finalSession, null, 2));

    return { finalSession, entries };
  };

  const promptTags = async (finalSession: Session) => {
    if (!process.stdin.isTTY) return;
    try {
      const tags = await runTagPicker(finalSession);
      if (tags.length > 0) {
        finalSession.tags = tags;
        await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(finalSession, null, 2));
        await writeMetaFile(finalSession, tags);
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
      const { finalSession, entries } = await finalizeSession();
      const reasonStr = autoStopReason
        ? ` (${autoStopReason === "max_duration" ? "max duration" : "no text timeout"})`
        : "";
      console.log(chalk.green(`Done: ${outputFile}${reasonStr}`));
      console.log(chalk.gray(`Transcribed ${entries.length} segments`));

      await promptTags(finalSession);
      process.exit(0);
    } catch (err) {
      stopStatus();
      await stopCapture(2000).catch(() => {});
      console.log(chalk.red(`Finalization failed: ${formatError(err)}`));
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

    let entries: TranscriptEntry[] = [];
    let finalSession: Session = session;
    try {
      const result = await finalizeSession();
      entries = result.entries;
      finalSession = result.finalSession;
    } catch (err) {
      console.log(chalk.red(`Finalization failed: ${formatError(err)}`));
      process.exit(1);
    }

    console.log(chalk.green(`Transcript: ${outputFile}`));
    console.log(chalk.gray(`Transcribed ${entries.length} segments`));

    if (entries.length === 0) {
      console.log(chalk.yellow("No transcript entries — skipping index generation"));
    } else {
      console.log(chalk.cyan("Creating index.md (up to 180s)..."));

      try {
        const indexMarkdown = await runOpencodeIndex(config, outputFile, title);
        const meetingDir = getOutputDir(config, title, startedAt);
        const indexPath = join(meetingDir, "index.md");
        await writeFile(indexPath, indexMarkdown, "utf-8");
        console.log(chalk.green(`Index: ${indexPath}`));
      } catch (err) {
        console.log(chalk.red(`Index generation failed: ${formatError(err)}`));
      }
    }

    await promptTags(finalSession);

    process.exit(0);
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

  const modelPath = expandPath(config.modelPath);
  if (!existsSync(modelPath)) {
    errors.push(`Model not found: ${modelPath}. Run: meet setup or scripts/setup.sh`);
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

  const modelPath = expandPath(config.modelPath);
  if (existsSync(modelPath)) {
    console.log(chalk.green("  model: ") + modelPath);
  } else {
    console.log(chalk.red("  model: NOT FOUND"));
    console.log(chalk.gray("    Download: curl -L -o ~/.meet/models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"));
    ok = false;
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
