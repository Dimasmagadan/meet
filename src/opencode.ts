import { execFile } from "node:child_process";
import type { Config } from "./types.js";

const INDEX_PROMPT = `You are cataloging a recorded call.

Read the attached transcript and create an index.md file for this call.

Write in the same primary language as the transcript.

Return only Markdown.

Include:

# <short descriptive title>

## Summary
A concise summary of the call in 5-10 bullets.

## Catalog
- Category: personal | work | mixed | unknown
- Work project: <project name or unknown>
- Call type: sync | planning | interview | sales | support | lecture | brainstorming | status update | other
- Participants: <names/roles if inferable, otherwise unknown>
- Date/time: <infer from transcript header if present>
- Language: <language>
- Confidence: high | medium | low

## Key Topics
Main topics discussed.

## Decisions
Important decisions made, if any.

## Action Items
Tasks, owners, and deadlines if inferable.

## Open Questions
Unresolved questions or follow-ups.

## Tags
5-10 short tags.`;

export async function runOpencodeIndex(
  config: Config,
  transcriptFile: string,
  title: string,
): Promise<string> {
  const args = [
    "run",
    `Meeting index: ${title}. ${INDEX_PROMPT}`,
    "-f", transcriptFile,
  ];
  return runOpencode(config, args, 180_000);
}

export async function runOpencodeQuestion(
  config: Config,
  transcriptFile: string,
  title: string,
  question: string,
): Promise<string> {
  const prompt = `Meeting question: ${title} Answer this question using the attached meeting transcript. Question: ${question}`;

  const args = [
    "run",
    prompt,
    "-f", transcriptFile,
  ];
  return runOpencode(config, args);
}

function runOpencode(config: Config, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      config.opencodeBin,
      args,
      { timeout, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = err.killed
            ? `opencode timed out after ${timeout / 1000}s`
            : cleanError(err.message);
          reject(new Error(msg));
          return;
        }
        resolve(stdout.trim() || stderr.trim());
      },
    );
  });
}

function cleanError(msg: string): string {
  return msg
    .split("\n")
    .filter((line) =>
      !line.includes("Plan Mode") &&
      !line.includes("READ-ONLY") &&
      !line.includes("System Reminder") &&
      !line.includes("operational mode") &&
      !line.includes("permitted to make")
    )
    .join("\n")
    .trim()
    .slice(0, 300);
}
