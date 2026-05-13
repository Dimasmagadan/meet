import { execFile } from "node:child_process";
import type { Config } from "./types.js";

const SUMMARY_PROMPT = `Summarize this meeting transcript so far. Return:
- Key points discussed
- Decisions made
- Action items and owners
- Open questions
- Risks or concerns

Use the same language as the transcript.`;

export async function runOpencodeSummary(
  config: Config,
  transcriptFile: string,
  title: string,
): Promise<string> {
  const args = [
    "run",
    "-f", transcriptFile,
    "--title", `Meeting summary: ${title}`,
    SUMMARY_PROMPT,
  ];
  return runOpencode(config, args);
}

export async function runOpencodeQuestion(
  config: Config,
  transcriptFile: string,
  title: string,
  question: string,
): Promise<string> {
  const prompt = `Answer this question using the attached meeting transcript.

Question:
${question}`;

  const args = [
    "run",
    "-f", transcriptFile,
    "--title", `Meeting question: ${title}`,
    prompt,
  ];
  return runOpencode(config, args);
}

function runOpencode(config: Config, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      config.opencodeBin,
      args,
      { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`opencode failed: ${err.message}`));
          return;
        }
        resolve(stdout.trim() || stderr.trim());
      },
    );
  });
}
