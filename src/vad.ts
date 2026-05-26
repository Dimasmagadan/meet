import { execFile } from "node:child_process";
import type { Config } from "./types.js";

export interface VadResult {
  speech: boolean;
  segments?: Array<{ startMs: number; endMs: number }>;
}

export async function detectSpeech(
  wavPath: string,
  config: Config,
  execFn: typeof execFile = execFile
): Promise<VadResult> {
  if (!config.vadEnabled || !config.vadBin) {
    return { speech: true };
  }

  const bin = config.vadBin.startsWith("~")
    ? config.vadBin.replace("~", process.env.HOME || "")
    : config.vadBin;

  const args = [
    "--threshold", String(config.vadThreshold ?? 0.5),
    "--min-speech-ms", String(config.vadMinSpeechMs ?? 250),
    wavPath,
  ];

  return new Promise<VadResult>((resolve) => {
    execFn(bin, args, { timeout: config.vadTimeoutMs ?? 30_000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) {
        if (config.vadFailOpen !== false) {
          resolve({ speech: true });
        } else {
          resolve({ speech: false });
        }
        return;
      }

      try {
        const result = JSON.parse(stdout.trim()) as VadResult;
        resolve({ speech: !!result.speech, segments: result.segments });
      } catch {
        if (config.vadFailOpen !== false) {
          resolve({ speech: true });
        } else {
          resolve({ speech: false });
        }
      }
    });
  });
}
