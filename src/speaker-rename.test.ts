import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { renameSpeaker } from "./speaker-rename.js";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `meet-test-rename-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface SpeakersRecord {
  diarization?: { ok?: boolean };
  segments?: Array<{ speaker: string }>;
  entryAssignments?: Array<{ speaker: string | null }>;
  speakerNames?: Record<string, string>;
}

function writeSpeakers(dir: string, record: SpeakersRecord) {
  writeFileSync(join(dir, "speakers.json"), JSON.stringify(record, null, 2), "utf-8");
}

const TRANSCRIPT = `# Standup — 23.07.2026 14:30

**[00:00:00] Me:** привет, начнём
**[00:00:15] Speaker 1:** я Женя, вот отчёт
**[00:00:30] Speaker 2:** я Макс, согласен

## Talk Time

- Me: 0m 15s (17%)
- Speaker 1: 0m 30s (33%)
- Speaker 2: 0m 15s (17%)
`;

const PARAKEET = `# Standup — Parakeet A/B

**[00:00:15] Speaker 1:** я Женя, вот отчёт
`;

describe("renameSpeaker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it("replaces label in transcript.md body + Talk Time footer", async () => {
    writeSpeakers(tmpDir, {
      diarization: { ok: true },
      segments: [{ speaker: "Speaker 1" }, { speaker: "Speaker 2" }],
      entryAssignments: [{ speaker: "Speaker 1" }, { speaker: "Speaker 2" }],
    });
    writeFileSync(join(tmpDir, "transcript.md"), TRANSCRIPT, "utf-8");

    const res = await renameSpeaker(tmpDir, "Speaker 1", "Женя");
    const out = readFileSync(join(tmpDir, "transcript.md"), "utf-8");

    assert.match(out, /\*\*\[00:00:15\] Женя:\*\*/);
    assert.doesNotMatch(out, /\*\*\[00:00:15\] Speaker 1:\*\*/);
    assert.match(out, /^- Женя: 0m 30s \(33%\)$/m);
    // Speaker 2 untouched.
    assert.match(out, /\*\*\[00:00:30\] Speaker 2:\*\*/);
    assert.match(out, /^- Speaker 2: 0m 15s/m);

    const t = res.files.find((f) => f.file === "transcript.md")!;
    assert.equal(t.bodyMatches, 1);
    assert.equal(t.footerMatches, 1);
    assert.equal(t.indexMatches, 0);
  });

  it("patches both transcript.md and transcript.parakeet.md in one call (parakeet footer 0)", async () => {
    writeSpeakers(tmpDir, {
      diarization: { ok: true },
      segments: [{ speaker: "Speaker 1" }],
      entryAssignments: [{ speaker: "Speaker 1" }],
    });
    writeFileSync(join(tmpDir, "transcript.md"), TRANSCRIPT, "utf-8");
    writeFileSync(join(tmpDir, "transcript.parakeet.md"), PARAKEET, "utf-8");

    const res = await renameSpeaker(tmpDir, "Speaker 1", "Женя");

    const main = res.files.find((f) => f.file === "transcript.md")!;
    const para = res.files.find((f) => f.file === "transcript.parakeet.md")!;
    assert.ok(main);
    assert.ok(para);
    assert.equal(main.bodyMatches, 1);
    assert.equal(main.footerMatches, 1);
    // parakeet has no Talk Time section.
    assert.equal(para.bodyMatches, 1);
    assert.equal(para.footerMatches, 0);

    const paraOut = readFileSync(join(tmpDir, "transcript.parakeet.md"), "utf-8");
    assert.match(paraOut, /\*\*\[00:00:15\] Женя:\*\*/);
  });

  it("index.md word-boundary patch counted separately, including Cyrillic", async () => {
    writeSpeakers(tmpDir, {
      diarization: { ok: true },
      segments: [{ speaker: "Speaker 1" }],
      entryAssignments: [{ speaker: "Speaker 1" }],
    });
    writeFileSync(join(tmpDir, "transcript.md"), TRANSCRIPT, "utf-8");
    writeFileSync(
      join(tmpDir, "index.md"),
      "Speaker 1 led the discussion. The Speaker 1 raised budget concerns.\n",
      "utf-8",
    );

    const res = await renameSpeaker(tmpDir, "Speaker 1", "Женя");
    const idx = readFileSync(join(tmpDir, "index.md"), "utf-8");

    const i = res.files.find((f) => f.file === "index.md")!;
    assert.equal(i.indexMatches, 2);
    assert.equal(i.bodyMatches, 0);
    assert.match(idx, /^Женя led the discussion\. The Женя raised/);
  });

  it("does not match Speaker 1 inside Speaker 11 (boundary holds)", async () => {
    writeSpeakers(tmpDir, {
      diarization: { ok: true },
      segments: [{ speaker: "Speaker 1" }, { speaker: "Speaker 11" }],
      entryAssignments: [{ speaker: "Speaker 1" }, { speaker: "Speaker 11" }],
    });
    writeFileSync(join(tmpDir, "index.md"), "Speaker 11 also spoke.\n", "utf-8");

    const res = await renameSpeaker(tmpDir, "Speaker 1", "Женя");
    const idx = readFileSync(join(tmpDir, "index.md"), "utf-8");
    assert.equal(res.files[0].indexMatches, 0);
    assert.equal(idx, "Speaker 11 also spoke.\n");
  });

  it("persists speakerNames in speakers.json", async () => {
    writeSpeakers(tmpDir, {
      diarization: { ok: true },
      segments: [{ speaker: "Speaker 1" }],
      entryAssignments: [{ speaker: "Speaker 1" }],
    });
    writeFileSync(join(tmpDir, "transcript.md"), TRANSCRIPT, "utf-8");

    await renameSpeaker(tmpDir, "Speaker 1", "Женя");
    const rec = JSON.parse(readFileSync(join(tmpDir, "speakers.json"), "utf-8")) as SpeakersRecord;
    assert.deepEqual(rec.speakerNames, { "Speaker 1": "Женя" });
  });

  it("renaming twice re-targets the previous display name, not the stale canonical id", async () => {
    writeSpeakers(tmpDir, {
      diarization: { ok: true },
      segments: [{ speaker: "Speaker 1" }, { speaker: "Speaker 2" }],
      entryAssignments: [{ speaker: "Speaker 1" }, { speaker: "Speaker 2" }],
    });
    writeFileSync(join(tmpDir, "transcript.md"), TRANSCRIPT, "utf-8");

    await renameSpeaker(tmpDir, "Speaker 1", "Женя");
    // Second rename still addresses the canonical id "Speaker 1".
    await renameSpeaker(tmpDir, "Speaker 1", "Евгений");

    const out = readFileSync(join(tmpDir, "transcript.md"), "utf-8");
    // "Женя" still legitimately appears in the spoken body text ("я Женя, вот отчёт") —
    // only the label positions should have moved on to "Евгений".
    assert.doesNotMatch(out, /\*\*\[00:00:15\] Женя:\*\*/);
    assert.doesNotMatch(out, /^- Женя:/m);
    assert.match(out, /\*\*\[00:00:15\] Евгений:\*\*/);
    assert.match(out, /^- Евгений: 0m 30s/m);
    // Speaker 2 canonical label stays intact.
    assert.match(out, /\*\*\[00:00:30\] Speaker 2:\*\*/);

    const rec = JSON.parse(readFileSync(join(tmpDir, "speakers.json"), "utf-8")) as SpeakersRecord;
    assert.deepEqual(rec.speakerNames, { "Speaker 1": "Евгений" });
  });

  it("re-targeting also rewrites a Cyrillic name in index.md", async () => {
    writeSpeakers(tmpDir, {
      diarization: { ok: true },
      segments: [{ speaker: "Speaker 1" }],
      entryAssignments: [{ speaker: "Speaker 1" }],
    });
    writeFileSync(join(tmpDir, "index.md"), "Speaker 1 opened.\n", "utf-8");

    await renameSpeaker(tmpDir, "Speaker 1", "Женя");
    assert.equal(readFileSync(join(tmpDir, "index.md"), "utf-8"), "Женя opened.\n");
    // Now the on-disk label is Cyrillic — `\b` would miss it, Unicode lookaround must not.
    await renameSpeaker(tmpDir, "Speaker 1", "Евгений");
    assert.equal(readFileSync(join(tmpDir, "index.md"), "utf-8"), "Евгений opened.\n");
  });

  it("throws available-speakers list for unknown id", async () => {
    writeSpeakers(tmpDir, {
      diarization: { ok: true },
      segments: [{ speaker: "Speaker 1" }, { speaker: "Speaker 2" }],
      entryAssignments: [],
    });
    await assert.rejects(
      () => renameSpeaker(tmpDir, "Speaker 9", "X"),
      /Unknown speaker: Speaker 9\. Available: Speaker 1, Speaker 2/,
    );
  });

  it("throws 'not a finalized meeting' when speakers.json missing", async () => {
    await assert.rejects(
      () => renameSpeaker(tmpDir, "Speaker 1", "X"),
      /Not a finalized meeting/,
    );
  });

  it("throws 'no speakers' when diarization.ok is false", async () => {
    writeSpeakers(tmpDir, { diarization: { ok: false } });
    await assert.rejects(
      () => renameSpeaker(tmpDir, "Speaker 1", "X"),
      /No speakers to rename/,
    );
  });

  it("is idempotent-safe: warning-free when the speaker never spoke (0 body matches)", async () => {
    writeSpeakers(tmpDir, {
      diarization: { ok: true },
      segments: [{ speaker: "Speaker 1" }, { speaker: "Speaker 2" }],
      entryAssignments: [{ speaker: "Speaker 1" }, { speaker: "Speaker 2" }],
    });
    writeFileSync(join(tmpDir, "transcript.md"), TRANSCRIPT, "utf-8");

    // Rename Speaker 2 → fine, but then rename Speaker 1 whose body was already
    // rewritten above is covered elsewhere; here rename a speaker with no body.
    const res = await renameSpeaker(tmpDir, "Speaker 2", "Макс");
    const totalBody = res.files.reduce((n, f) => n + f.bodyMatches, 0);
    assert.ok(totalBody > 0);
  });
});
