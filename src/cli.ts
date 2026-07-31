import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getOutputPath, getOutputDir, getCaptureBinPath, resolveAnalysisBin, findStaleSessions, expandPath, writeAtomic, getSessionsDir, resolveWhisperBin, resolveModelPath } from "./storage.js";
import { Recorder } from "./recorder.js";
import { makeHeader } from "./assembler.js";
import { finalizeSession } from "./finalize.js";
import { showStatus } from "./status.js";
import { isActiveRecording, readActiveRecordingLock, acquireGlobalFinalPassLock, releaseGlobalFinalPassLock } from "./locks.js";
import { transcribeImport, type ImportOptions } from "./import.js";
import { renameSpeaker } from "./speaker-rename.js";
import { loadRegistry, saveRegistry, forgetSpeaker, matchesLogPath } from "./speaker-registry.js";
import { detectGitContext, linkRepoToMeeting } from "./git-context.js";
import { detectWhisperCompute } from "./compute-device.js";
import { isTaskpolicyAvailable } from "./process-priority.js";
import { spawn, execSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Session, Config } from "./types.js";
import { analyzeWavFile } from "./audio-metrics.js";
import { generateDashboard } from "./dashboard.js";
import { getTriggers } from "./triggers.js";
import { sendMacNotification, type AttentionAlert } from "./attention.js";

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
    .option("--headless", "Run without terminal interaction (for menu bar app / automation)")
    .option("--no-summary", "Disable live extractive summary during recording")
    .option("--repo <path>", "Attach git repo context from <path> (default: current working directory)")
    .action(async (title: string, opts: { mic?: boolean; silence?: number; maxDuration?: number; noTextTimeout?: number; voiceProcessing?: boolean; headless?: boolean; summary?: boolean; repo?: string }) => {
      const mode = opts.mic ? "mic" as const : "full" as const;
      await startSessionLoop(title, mode, opts.silence ?? 0, opts.maxDuration, opts.noTextTimeout, opts.voiceProcessing, opts.headless, opts.summary, opts.repo);
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
    .command("rename")
    .description("Rename a diarized speaker label in a finalized meeting")
    .argument("<meetingDir>", "Meeting output directory path")
    .argument("<speakerId>", 'Speaker id, e.g. "Speaker 1"')
    .argument("<newName>", "New display name")
    .action(async (meetingDir: string, speakerId: string, newName: string) => {
      await runRename(meetingDir, speakerId, newName);
    });

  program
    .command("link")
    .description("Attach or replace git repo context in a finalized meeting's meta.md")
    .argument("<meetingDir>", "Meeting output directory path")
    .argument("<repoPath>", "Path inside the git repo to attach (re-detects from here)")
    .action(async (meetingDir: string, repoPath: string) => {
      await runLink(meetingDir, repoPath);
    });

  const speakers = program.command("speakers").description("Manage the cross-session speaker registry");
  speakers
    .command("list")
    .description("List registry entries and recent borderline matches")
    .action(async () => {
      await runSpeakersList();
    });
  speakers
    .command("forget")
    .description("Drop a registry speaker so its voice re-registers fresh")
    .argument("<globalId>", "Registry speaker id (from `meet speakers list`)")
    .action(async (globalId: string) => {
      await runSpeakersForget(globalId);
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

  program
    .command("dashboard")
    .description("Generate HTML dashboard with meeting stats")
    .option("--output <path>", "Output file path", "~/Meetings/dashboard.html")
    .action(async (opts: { output?: string }) => {
      await generateDashboard(opts.output);
    });

  program
    .command("bin-path")
    .description("Print resolved runner paths as JSON (node + meet main) — used by the menu bar app")
    .action(() => {
      console.log(JSON.stringify(resolveRunnerPaths(loadConfig())));
    });

  return program;
}

async function startSessionLoop(initialTitle: string, mode: "full" | "mic", silenceTimeout: number = 0, maxDurationMinutes?: number, noTextTimeoutMinutes?: number, voiceProcessing?: boolean, headless?: boolean, summary?: boolean, repoOverride?: string) {
  let title = initialTitle;

  while (true) {
    const result = await startSession(title, mode, silenceTimeout, maxDurationMinutes, noTextTimeoutMinutes, voiceProcessing, headless, summary, repoOverride);
    if (!result.startNextMeeting) {
      break;
    }
    title = "meeting";
    console.log(chalk.cyan("\nStarting next meeting...\n"));
  }
}

async function startSession(title: string, mode: "full" | "mic", silenceTimeout: number = 0, maxDurationMinutes?: number, noTextTimeoutMinutes?: number, voiceProcessing?: boolean, headless?: boolean, summary?: boolean, repoOverride?: string): Promise<{ startNextMeeting: boolean }> {
  const summaryEnabled = summary === false ? false : true;
  const config = loadConfig({ ...(summaryEnabled ? {} : { summaryEnabled: false }) });

  const stale = findStaleSessions();
  if (stale.length > 0) {
    console.log(chalk.yellow("Warning: stale sessions found:"));
    for (const s of stale) {
      console.log(chalk.yellow(`  ${s}`));
    }
    console.log(chalk.yellow("  Run manually: meet finalize <sessionDir>"));
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

  // Local-only git context: --repo <path> overrides cwd. Fail-open silently for
  // the default cwd (recording is never gated), but warn when an explicit --repo
  // doesn't resolve to a repo so typos aren't swallowed. Detached HEAD keeps
  // headSha, drops branch.
  const repoCwd = expandPath(repoOverride ?? process.cwd());
  const gitContext = detectGitContext(repoCwd);
  if (repoOverride && !gitContext) {
    console.log(chalk.yellow(`--repo: not a git repository: ${repoOverride}`));
  }

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
    gitContext,
  };

  await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

  if (gitContext) {
    const where = gitContext.branch ?? "detached";
    console.log(chalk.gray(`Repo: ${gitContext.repoName} @ ${gitContext.headSha} (${where})`));
  }

  console.log(
    chalk.gray("Press ") +
      chalk.bold("q") +
      chalk.gray(" to quit (bg all), ") +
      chalk.bold("s") +
      chalk.gray(" to stop (drain live inline), ") +
      chalk.bold("n") +
      chalk.gray(" to next meeting, ") +
      chalk.bold("p") +
      chalk.gray(" to pause, ") +
      chalk.bold("e") +
      chalk.gray(" to +15m, ") +
      chalk.bold("a") +
      chalk.gray(" to ask opencode\n"),
  );

  const recorder = new Recorder(session, config, {
    silenceTimeout,
    maxDurationMinutes: maxDurationMinutes ?? config.maxDurationMinutes,
    noTextTimeoutMinutes: noTextTimeoutMinutes ?? config.noTextTimeoutMinutes,
    voiceProcessing: voiceProcessing ?? config.micVoiceProcessing,
    headless: headless ?? false,
  });

  return await recorder.run();
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

  const captureBin = getCaptureBinPath(config);
  if (!existsSync(captureBin)) {
    errors.push(`AudioCapture not built: ${captureBin}. Run: ./native/AudioCapture/scripts/build.sh`);
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

  const captureBin = getCaptureBinPath(config);
  if (existsSync(captureBin)) {
    console.log(chalk.green("  AudioCapture: ") + captureBin);
  } else {
    console.log(chalk.red("  AudioCapture: NOT BUILT"));
    console.log(chalk.gray("    Build: ./native/AudioCapture/scripts/build.sh"));
    ok = false;
  }

  const analysisBin = resolveAnalysisBin(config);
  if (existsSync(analysisBin)) {
    console.log(chalk.green("  AudioAnalysis: ") + analysisBin);
    console.log(chalk.gray("    Downloading diarization + Parakeet CoreML models, one-time, ~1 GB..."));
    try {
      execSync(`"${analysisBin}" models --ensure`, { stdio: "inherit" });
    } catch {
      console.log(chalk.yellow("    Model download/verify failed (speaker diarization and Parakeet A/B pass will be skipped until fixed)"));
    }
  } else {
    console.log(chalk.yellow("  AudioAnalysis: NOT BUILT (speaker diarization and Parakeet A/B pass disabled, optional)"));
    console.log(chalk.gray("    Build: cd native/AudioCapture && swift build --product AudioAnalysis -c release"));
  }

  const outputDir = expandPath(config.outputDir);
  await mkdir(outputDir, { recursive: true });
  console.log(chalk.green("  output dir: ") + outputDir);

  try {
    const opencodePath = execSync("which opencode 2>/dev/null", { encoding: "utf-8" }).trim();
    console.log(chalk.green("  opencode: ") + opencodePath);
    console.log(chalk.gray(`    index.md on recordings: ${config.opencodeIndexPass ? "enabled" : "disabled (set opencodeIndexPass: true in config.json)"}`));
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

  const analysisBin = resolveAnalysisBin(config);
  if (existsSync(analysisBin)) {
    console.log(chalk.green(`AudioAnalysis: ${analysisBin}`));
    const cacheDir = join(homedir(), "Library", "Application Support", "FluidAudio");
    console.log(existsSync(cacheDir)
      ? chalk.green(`  models cache: ${cacheDir}`)
      : chalk.yellow("  models cache: not found (run meet setup to download, ~1 GB)"));
  } else {
    console.log(chalk.yellow("AudioAnalysis: not built (speaker diarization and Parakeet A/B pass disabled)"));
  }

  // P2: report whisper's active compute device. The probe runs `whisper-cli
  // --help`, whose backend-init log tells us whether Metal loaded (free — no
  // transcription). whisper.cpp exposes no positive `--metal` flag (GPU is on
  // by default; only `-ng`/`--no-gpu` and `-dev N` exist), so we report the
  // device only — there is no flag to emit or surface.
  const whisperBin = resolveWhisperBin(config);
  const compute = await detectWhisperCompute(whisperBin);
  if (compute.metalActive) {
    const dev = compute.gpuName ? ` — ${compute.gpuName}` : "";
    console.log(chalk.green(`compute: Metal${dev}`));
  } else if (compute.backendLines.length > 0) {
    console.log(chalk.yellow("compute: CPU (no Metal backend loaded)"));
    for (const l of compute.backendLines) console.log(chalk.gray(`  ${l.trim()}`));
  } else {
    console.log(chalk.yellow("compute: unknown (whisper-cli --help unavailable)"));
  }

  // P3: confirm whether batch/live model spawns are QoS-lowered so the Swift
  // capture keeps priority during recording.
  const qosAvailable = isTaskpolicyAvailable();
  if (config.lowerProcessPriority && qosAvailable) {
    console.log(chalk.green("process priority: taskpolicy -c utility (whisper/AudioAnalysis lowered; capture keeps priority)"));
  } else {
    const why = !qosAvailable ? "taskpolicy unavailable" : "disabled (lowerProcessPriority: false)";
    console.log(chalk.yellow(`process priority: off (${why})`));
  }

  if (config.attentionAlerts) {
    const triggers = getTriggers(config);
    console.log(chalk.green(`triggers: ${triggers.triggerCount} loaded from ${expandPath(config.triggersPath)}`));
    const testAlert: AttentionAlert = {
      kind: "trigger",
      trigger: "test",
      snippet: "meet doctor test notification",
      timestamp: new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      chunkIndex: 0,
      recapEntries: 0,
    };
    try {
      await sendMacNotification(testAlert, config.attentionSound);
      console.log(chalk.gray("Sent a test notification. If no banner appeared, allow notifications for your terminal app in System Settings → Notifications."));
    } catch (err) {
      console.log(chalk.yellow(`Test notification failed: ${err instanceof Error ? err.message : String(err)}`));
    }
  } else {
    console.log(chalk.yellow("attention alerts: disabled"));
  }

  if (config.summaryEnabled) {
    console.log(chalk.green(`summary: enabled (every ${config.summaryIntervalChunks} chunks, top ${config.summaryTopN}/${config.summaryWindowMaxEntries} window, pause @ cpu>${config.summaryCpuThresholdLoad} or mem<${config.summaryMemThresholdMb}MB)`));
  } else {
    console.log(chalk.yellow("summary: disabled"));
  }

  if (config.speakerRegistryEnabled) {
    const registry = loadRegistry(config.speakerRegistryPath);
    const active = registry.speakers.filter((s) => !s.quarantined).length;
    console.log(chalk.green(`speaker registry: enabled (${active} active, ${registry.speakers.length} total) @ ${expandPath(config.speakerRegistryPath)}, match threshold ${config.speakerMatchThreshold}`));
  } else {
    console.log(chalk.yellow("speaker registry: disabled (set speakerRegistryEnabled: true in ~/.meet/config.json)"));
  }

  const sessionDir = await mkdtemp(join(tmpdir(), "meet-doctor-"));
  const captureBin = getCaptureBinPath(config);
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

async function runRename(meetingDir: string, speakerId: string, newName: string) {
  const dir = expandPath(meetingDir);
  const config = loadConfig();
  try {
    const result = await renameSpeaker(dir, speakerId, newName, {
      speakerRegistryEnabled: config.speakerRegistryEnabled,
      registryPath: config.speakerRegistryPath,
    });
    const summary = result.files
      .map((f) => {
        const bits: string[] = [];
        if (f.bodyMatches > 0) bits.push(`body ${f.bodyMatches}`);
        if (f.footerMatches > 0) bits.push(`footer ${f.footerMatches}`);
        if (f.indexMatches > 0) bits.push(`${f.indexMatches}`);
        return `${f.file} (${bits.join(", ")})`;
      })
      .join(", ");
    console.log(chalk.green(`renamed ${speakerId} → ${newName}: ${summary}`));

    const totalBody = result.files.reduce((n, f) => n + f.bodyMatches, 0);
    if (totalBody === 0) {
      console.log(chalk.yellow(`  (no transcript entries found for ${speakerId} — they may not have spoken)`));
    }

    if (result.registryUpdated) {
      console.log(chalk.gray(`  cross-session registry updated: future meetings will auto-label this voice "${newName}"`));
    }
  } catch (err) {
    console.log(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

async function runLink(meetingDir: string, repoPath: string) {
  const dir = expandPath(meetingDir);
  const repo = expandPath(repoPath);
  try {
    const result = await linkRepoToMeeting(dir, repo);
    console.log(chalk.green(`${result.replaced ? "updated" : "linked"} repo in ${result.metaPath}`));
    console.log(chalk.gray(`  ${result.repoLine}`));
  } catch (err) {
    console.log(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}

async function runSpeakersList() {
  const config = loadConfig();
  if (!config.speakerRegistryEnabled) {
    console.log(chalk.yellow("Speaker registry is disabled. Set speakerRegistryEnabled: true in ~/.meet/config.json"));
    return;
  }

  const registry = loadRegistry(config.speakerRegistryPath);
  const speakers = [...registry.speakers].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (speakers.length === 0) {
    console.log(chalk.gray(`No registry speakers yet (${expandPath(config.speakerRegistryPath)}).`));
    return;
  }

  console.log(chalk.cyan(`${speakers.length} speaker(s) in registry:\n`));
  for (const s of speakers) {
    const name = s.name ? chalk.green(s.name) : chalk.gray("(unnamed)");
    const flagged = s.quarantined ? chalk.yellow(" [quarantined]") : "";
    console.log(`  ${chalk.bold(s.id)}  ${name}${flagged}`);
    console.log(chalk.gray(`    matches: ${s.matchCount} | backend: ${s.backend} | first: ${s.sourceMeetingId} | ${s.createdAt}`));
  }

  const logPath = matchesLogPath(config.speakerRegistryPath);
  if (existsSync(logPath)) {
    try {
      const raw = await readFile(logPath, "utf-8");
      const lines = raw.split("\n").filter(Boolean).slice(-10);
      if (lines.length > 0) {
        console.log(chalk.cyan("\nRecent matches.log:"));
        for (const line of lines) console.log(chalk.gray(`  ${line}`));
      }
    } catch {}
  }
}

async function runSpeakersForget(globalId: string) {
  const config = loadConfig();
  if (!config.speakerRegistryEnabled) {
    console.log(chalk.yellow("Speaker registry is disabled."));
    process.exit(1);
  }

  // Serialize against concurrent finalize/rename — both also do load → mutate →
  // save on the registry file under this lock. Without it, a background finalize
  // could clobber this forget (or vice versa).
  const locked = acquireGlobalFinalPassLock("<registry-mutation>");
  if (!locked) {
    console.log(chalk.red("Registry busy: a final pass is running, retry in a moment."));
    process.exit(1);
  }
  try {
    const registry = loadRegistry(config.speakerRegistryPath);
    if (!forgetSpeaker(registry, globalId)) {
      console.log(chalk.red(`No registry speaker with id ${globalId}`));
      process.exit(1);
    }
    await saveRegistry(registry, config.speakerRegistryPath);
    console.log(chalk.green(`Forgot ${globalId}; its voice will re-register fresh in the next meeting.`));
  } finally {
    releaseGlobalFinalPassLock();
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

function which(cmd: string): string | null {
  try {
    const out = execSync(`command -v ${cmd} 2>/dev/null`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

// Resolve the runner the menu bar app should spawn: `node <main.js> start <title> --headless`.
// Resolution: menuBarMeetBin config override → realpath of the running dist/main.js
// (authoritative for local dev, npm link, and global installs — `meet bin-path` always runs
// from within meet, so process.argv[1] is the real JS file) → repo dist/main.js fallback.
// `node` always via `which node` with /opt/homebrew/bin/node fallback.
function resolveRunnerPaths(config: Config): { node: string; main: string; meet: string } {
  const node = which("node") ?? "/opt/homebrew/bin/node";

  if (config.menuBarMeetBin && config.menuBarMeetBin.trim() !== "") {
    const main = expandPath(config.menuBarMeetBin);
    return { node, main, meet: which("meet") ?? main };
  }

  // process.argv[1] is always the JS entry when Node runs a script (npm link,
  // local, or global). Fail loudly instead of guessing a path that wouldn't exist
  // on any other machine.
  const argv1 = process.argv[1];
  if (!argv1) throw new Error("meet bin-path: cannot resolve main.js (process.argv[1] is unset)");
  const argvMain = realpathSync(argv1);
  return { node, main: argvMain, meet: which("meet") ?? argvMain };
}
