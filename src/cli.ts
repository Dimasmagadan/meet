import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getOutputPath, getOutputDir, getCaptureBinPath, findStaleSessions, expandPath, writeAtomic, getSessionsDir, resolveWhisperBin, resolveModelPath } from "./storage.js";
import { Recorder } from "./recorder.js";
import { makeHeader } from "./assembler.js";
import { finalizeSession } from "./finalize.js";
import { showStatus } from "./status.js";
import { isActiveRecording, readActiveRecordingLock } from "./locks.js";
import { transcribeImport, type ImportOptions } from "./import.js";
import { spawn, execSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Session, Config } from "./types.js";
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

  if (isActiveRecording()) {
    const lock = readActiveRecordingLock();
    console.log(chalk.red("Another recording is already active."));
    if (lock) {
      console.log(chalk.gray(`  Title: ${lock.title}`));
      console.log(chalk.gray(`  PID: ${lock.pid}`));
      console.log(chalk.gray(`  Session: ${lock.sessionDir}`));
    }
    process.exit(1);
  }

  const id = nanoid(8);
  const sessionsDir = getSessionsDir();
  const sessionDir = join(sessionsDir, `meet-${id}`);
  await mkdir(sessionDir, { recursive: true });

  const startedAt = new Date();
  const meetingDir = getOutputDir(config, title, startedAt);
  const outputFile = getOutputPath(config, title, startedAt);

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

  console.log(chalk.gray("Press q/s to stop, p to pause, e to +15m, a to ask opencode\n"));

  const recorder = new Recorder(session, config, {
    silenceTimeout,
    maxDurationMinutes: maxDurationMinutes ?? config.maxDurationMinutes,
    noTextTimeoutMinutes: noTextTimeoutMinutes ?? config.noTextTimeoutMinutes,
    voiceProcessing: voiceProcessing ?? config.micVoiceProcessing,
  });

  await recorder.run();
}

function checkSetup(config: Config, mode: string): string[] {
  const errors: string[] = [];

  const whisperPath = resolveWhisperBin(config);
  if (!existsSync(whisperPath)) {
    errors.push("whisper-cli not found. Install: brew install whisper-cpp");
  }

  const liveModelPath = resolveModelPath(config, "live");
  if (!existsSync(liveModelPath)) {
    errors.push(`Live model not found: ${liveModelPath}. Run: meet setup or scripts/setup.sh`);
  }

  if (config.finalRetranscribe) {
    const finalModelPath = resolveModelPath(config, "final");
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

  const whisperPath = resolveWhisperBin(config);
  if (existsSync(whisperPath)) {
    console.log(chalk.green("  whisper-cli: ") + whisperPath);
  } else {
    console.log(chalk.red("  whisper-cli: NOT FOUND"));
    console.log(chalk.gray("    Install: brew install whisper-cpp"));
    ok = false;
  }

  const liveModelPath = resolveModelPath(config, "live");
  if (existsSync(liveModelPath)) {
    console.log(chalk.green("  live model: ") + liveModelPath);
  } else {
    console.log(chalk.red("  live model: NOT FOUND"));
    console.log(chalk.gray("    Download: curl -L -o ~/.meet/models/ggml-small.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"));
    ok = false;
  }

  if (config.finalRetranscribe) {
    const finalModelPath = resolveModelPath(config, "final");
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
