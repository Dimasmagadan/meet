import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "./types.js";

export interface TranscribeResult {
  chunkIndex: number;
  source: "mic" | "sys";
  text: string;
}

const HALLUCINATION_PATTERNS: RegExp[] = [
  /редактор\s+субтитров/i,
  /корректор/i,
  /субтитры?\s+(выполнил|делал|сделал)/i,
  /технические\s+работы/i,
  /просим\s+прощения/i,
  /канал\s+обновлен/i,
  /подписывайтесь/i,
];

function cleanText(raw: string): string {
  let text = raw;
  text = text.replace(/\[[^\]]*\]/g, "");
  text = text.replace(/\([^)]*\)/g, "");
  text = text.replace(/\s+/g, " ").trim();

  for (const pattern of HALLUCINATION_PATTERNS) {
    if (pattern.test(text)) {
      const before = text;
      const lines = text.split(/(?<=[.!?])\s*/);
      text = lines.filter((l) => !pattern.test(l)).join(" ");
    }
  }

  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export async function transcribeChunk(
  wavPath: string,
  config: Config,
  chunkIndex: number,
  source: "mic" | "sys"
): Promise<TranscribeResult> {
  const modelPath = config.modelPath.startsWith("~")
    ? config.modelPath.replace("~", process.env.HOME || "")
    : config.modelPath;

  const outFile = wavPath.replace(/\.wav$/, ".txt");

  const args = [
    "-m", modelPath,
    "-l", config.language,
    "-f", wavPath,
    "--no-timestamps",
    "-otxt",
    "-of", wavPath.replace(/\.wav$/, ""),
    "--suppress-nst",
    "--entropy-thold", "1.5",
    "--logprob-thold", "-0.5",
    "--no-speech-thold", "0.6",
    "--no-prints",
    "--prompt", config.prompt,
  ];

  return new Promise((resolve, reject) => {
    execFile(config.whisperBin, args, { timeout: 120_000, maxBuffer: 1024 * 1024 }, async (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`whisper-cli failed for ${wavPath}: ${err.message}`));
        return;
      }

      try {
        const raw = (await readFile(outFile, "utf-8")).trim();
        await unlink(outFile).catch(() => {});
        const text = cleanText(raw);
        resolve({ chunkIndex, source, text });
      } catch {
        const text = "";
        resolve({ chunkIndex, source, text });
      }
    });
  });
}

export function parseChunkFilename(filename: string): { source: "mic" | "sys"; index: number } | null {
  const match = filename.match(/^(mic|sys)-(\d{3})\.wav$/);
  if (!match) return null;
  return { source: match[1] as "mic" | "sys", index: parseInt(match[2], 10) };
}
