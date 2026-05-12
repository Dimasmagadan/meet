import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, getOutputPath, ensureDir, getCaptureBinPath, findStaleSessions, expandPath, writeAtomic } from "./storage.js";
import { Pipeline } from "./pipeline.js";
import { assembleMarkdown, entriesFromSession } from "./assembler.js";
import { spawn, ChildProcess } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import type { Session, Config } from "./types.js";

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
    .action(async (title: string, opts: { mic?: boolean }) => {
      await startSession(title, opts.mic ? "mic" : "full");
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

async function startSession(title: string, mode: "full" | "mic") {
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

  const id = nanoid(8);
  const sessionDir = `/tmp/meet-${id}`;
  await mkdir(sessionDir, { recursive: true });

  const startedAt = new Date();
  const outputFile = getOutputPath(config, title, startedAt);
  const captureBin = getCaptureBinPath();

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
  };

  await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

  await ensureDir(config.outputDir);

  const pipeline = new Pipeline(session);
  let micChunks = 0;
  let sysChunks = 0;

  pipeline.setTranscribeCallback((source, index, text) => {
    if (source === "mic") micChunks = Math.max(micChunks, index);
    else sysChunks = Math.max(sysChunks, index);
  });

  pipeline.start();

  const captureArgs = [
    "--output-dir", sessionDir,
    "--chunk-duration", String(config.chunkDurationSeconds),
    "--mode", mode,
  ];

  let captureProcess: ChildProcess | null = null;

  try {
    captureProcess = spawn(captureBin, captureArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    session.capturePid = captureProcess.pid ?? null;
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

    captureProcess.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line.startsWith("finalized:")) {
        const filename = line.replace("finalized:", "").trim();
        const source = filename.startsWith("mic") ? "mic" : "sys";
        if (source === "mic") micChunks++;
        else sysChunks++;
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

  const statusInterval = setInterval(() => {
    const stats = pipeline.getStats();
    const elapsed = Math.floor((Date.now() - startedAt.getTime()) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const secs = String(elapsed % 60).padStart(2, "0");
    const now = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    process.stdout.write(
      `\r${chalk.cyan(`Recording ${mins}:${secs}`)} | chunks: mic ${micChunks}, sys ${sysChunks} | transcribed: ${stats.totalDone} | last: ${now}  `
    );
  }, 5000);

  let shuttingDown = false;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    clearInterval(statusInterval);
    process.stdout.write("\n");
    console.log(chalk.yellow("Finalizing..."));

    session.status = "finalizing";
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(session, null, 2));

    if (captureProcess && !captureProcess.killed) {
      captureProcess.kill("SIGINT");
      await new Promise<void>((resolve) => {
        captureProcess?.on("exit", () => resolve());
        setTimeout(() => {
          captureProcess?.kill("SIGKILL");
          resolve();
        }, 5000);
      });
    }

    await pipeline.stop();

    const finalSession = await readFile(join(sessionDir, "session.json"), "utf-8").then(
      (d) => JSON.parse(d) as Session
    ).catch(() => session);

    const results = pipeline.getResults();
    const entries = entriesFromSession(finalSession, results);
    const markdown = assembleMarkdown(title, finalSession.startedAt, entries);

    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputFile, markdown, "utf-8");

    finalSession.status = "done";
    await writeAtomic(join(sessionDir, "session.json"), JSON.stringify(finalSession, null, 2));

    console.log(chalk.green(`Done: ${outputFile}`));
    console.log(chalk.gray(`Transcribed ${entries.length} chunks`));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
  const files = (await readdirSync(outputDir)).filter((f) => f.endsWith(".md")).sort().reverse();

  if (files.length === 0) {
    console.log("No meetings found.");
    return;
  }

  for (const f of files) {
    console.log(`  ${f.replace(".md", "")}`);
  }
}
