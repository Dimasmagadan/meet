import { readFileSync } from "node:fs";
import { writeFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import { writeAtomic } from "./storage.js";
import type { Session } from "./types.js";

const TAGS_FILE = resolve(import.meta.dirname, "..", "tags.md");
const DONE_OPTION = "> Done";
const NEW_TAG_OPTION = "> Enter new tag...";
const TIMEOUT_MS = 180_000;

export function readTags(): string[] {
  if (!existsSync(TAGS_FILE)) return [];
  const raw = readFileSync(TAGS_FILE, "utf-8");
  return parseTags(raw);
}

function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const tag = trimmed.replace(/^[-*]\s*/, "").trim();
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      tags.push(tag);
    }
  }
  return tags;
}

export async function appendTagToFile(tag: string): Promise<void> {
  const line = `- ${tag}\n`;
  if (!existsSync(TAGS_FILE)) {
    await writeFile(TAGS_FILE, `# Tags\n\n${line}`, "utf-8");
  } else {
    await appendFile(TAGS_FILE, line, "utf-8");
  }
}

export async function writeMetaFile(session: Session, tags: string[]): Promise<void> {
  const meetingDir = dirname(session.outputFile);
  const metaPath = resolve(meetingDir, "meta.md");
  const date = new Date(session.startedAt);
  const dateStr = date.toLocaleDateString("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit" });
  const timeStr = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  const lines = [
    `# ${session.title}`,
    "",
    `- Date: ${dateStr} ${timeStr}`,
    `- Mode: ${session.mode}`,
    `- Tags: ${tags.join(", ")}`,
    "",
  ];

  await writeAtomic(metaPath, lines.join("\n"));
}

function hasTagCaseInsensitive(arr: string[], tag: string): boolean {
  const lower = tag.toLowerCase();
  return arr.some(t => t.toLowerCase() === lower);
}

export async function runTagPicker(session: Session): Promise<string[]> {
  const selectedTags: string[] = [];
  const pendingAppends: Promise<void>[] = [];
  let existingTags = readTags();
  let cursor = 0;
  let enteringNew = false;
  let newTagBuffer = "";

  const options = (): string[] => [...existingTags, DONE_OPTION, NEW_TAG_OPTION];

  const render = () => {
    const opts = options();
    process.stdout.write("\x1B[?25l");
    process.stdout.write("\x1B[2J\x1B[H");
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    process.stdout.write(
      chalk.cyan("Add tags to this call") +
      chalk.gray(` (up/down move, Enter select, Ctrl-C skip, ${remaining}s timeout)\n\n`)
    );

    if (selectedTags.length > 0) {
      process.stdout.write(chalk.green(`Selected: ${selectedTags.join(", ")}\n\n`));
    }

    for (let i = 0; i < opts.length; i++) {
      const prefix = i === cursor ? chalk.cyan("> ") : "  ";
      let label: string;
      if (opts[i] === DONE_OPTION) {
        label = selectedTags.length > 0 ? chalk.green(opts[i]) : chalk.gray(opts[i]);
      } else if (opts[i] === NEW_TAG_OPTION) {
        label = chalk.yellow(opts[i]);
      } else if (selectedTags.includes(opts[i])) {
        label = chalk.green(`+ ${opts[i]}`);
      } else {
        label = opts[i];
      }
      process.stdout.write(`${prefix}${label}\n`);
    }

    if (enteringNew) {
      process.stdout.write("\n" + chalk.cyan("New tag: ") + newTagBuffer + "_");
    }

    process.stdout.write("\x1B[?25h");
  };

  const deadline = Date.now() + TIMEOUT_MS;

  return new Promise<string[]>((resolve) => {
    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", onData);
      if (timer) clearTimeout(timer);
      process.stdout.write("\x1B[?25h");
      process.stdout.write("\n");
    };

    const finish = async (tags: string[]) => {
      cleanup();
      await Promise.all(pendingAppends).catch(() => {});
      resolve(tags);
    };

    const timer = setTimeout(() => {
      process.stdout.write(chalk.gray("\nTag picker timed out.\n"));
      finish([]);
    }, TIMEOUT_MS);

    const onData = (data: Buffer) => {
      const buf = data.toString();

      if (buf === "\x03") {
        finish([]);
        return;
      }

      if (enteringNew) {
        if (buf === "\r" || buf === "\n") {
          const newTag = newTagBuffer.trim();
          if (newTag) {
            if (!hasTagCaseInsensitive(selectedTags, newTag)) {
              selectedTags.push(newTag);
            }
            if (!hasTagCaseInsensitive(existingTags, newTag)) {
              existingTags.push(newTag);
              pendingAppends.push(appendTagToFile(newTag));
            }
          }
          enteringNew = false;
          newTagBuffer = "";
          cursor = 0;
        } else if (buf === "\x7f" || buf === "\b") {
          newTagBuffer = newTagBuffer.slice(0, -1);
        } else if (buf === "\x1b") {
          enteringNew = false;
          newTagBuffer = "";
          cursor = 0;
        } else if (buf.charCodeAt(0) >= 32) {
          newTagBuffer += buf;
        }
        render();
        return;
      }

      if (buf === "\x1B[A" || buf === "k") {
        cursor = (cursor - 1 + options().length) % options().length;
      } else if (buf === "\x1B[B" || buf === "j") {
        cursor = (cursor + 1) % options().length;
      } else if (buf === "\r" || buf === "\n") {
        const opts = options();
        const chosen = opts[cursor];
        if (chosen === DONE_OPTION) {
          finish(selectedTags);
          return;
        } else if (chosen === NEW_TAG_OPTION) {
          enteringNew = true;
          newTagBuffer = "";
        } else {
          const idx = selectedTags.indexOf(chosen);
          if (idx >= 0) {
            selectedTags.splice(idx, 1);
          } else {
            selectedTags.push(chosen);
          }
        }
      }
      render();
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    render();
  });
}
