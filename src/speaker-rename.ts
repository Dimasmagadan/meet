import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./storage.js";
import { escapeRegex } from "./regex-utils.js";
import { loadRegistry, saveRegistry } from "./speaker-registry.js";
import { acquireGlobalFinalPassLock, releaseGlobalFinalPassLock } from "./locks.js";

export interface RenameFileCount {
  file: string;            // basename: "transcript.md", "transcript.parakeet.md", "index.md"
  bodyMatches: number;     // `**[HH:MM:SS] LABEL:**` replacements (0 on index.md)
  footerMatches: number;   // `- LABEL: ` Talk Time row replacements (0 on index.md and parakeet)
  indexMatches: number;    // bare word-boundary label replacements (only index.md; 0 elsewhere)
}

export interface RenameResult {
  files: RenameFileCount[];
  registryUpdated?: boolean;   // true when the name was propagated to the cross-session registry
}

export interface RenameOptions {
  speakerRegistryEnabled?: boolean;
  registryPath?: string;
}

interface SpeakersRecord {
  diarization?: { ok?: boolean };
  segments?: Array<{ speaker: string }>;
  entryAssignments?: Array<{ speaker: string | null }>;
  speakerNames?: Record<string, string>;
  speakerRegistry?: Record<string, { globalSpeakerId: string; matchedName: string | null }>;
}

function speakerSortKey(label: string): number {
  const m = /^Speaker (\d+)$/.exec(label);
  return m ? parseInt(m[1], 10) : Infinity;
}

// Patches the canonical `Speaker N` label to a real display name across every
// `transcript*.md` (rewriteMarkdown output) and `index.md` (opencode prose) in
// the finalized meeting dir, persisting the mapping in speakers.json. The
// canonical id never changes — speakerNames[id] holds the current display label,
// so renaming twice re-targets the previously-applied name.
export async function renameSpeaker(
  meetingDir: string,
  speakerId: string,
  newName: string,
  options?: RenameOptions,
): Promise<RenameResult> {
  const speakersPath = join(meetingDir, "speakers.json");
  if (!existsSync(speakersPath)) {
    throw new Error(`Not a finalized meeting (no speakers.json in ${meetingDir})`);
  }

  const record = JSON.parse(await readFile(speakersPath, "utf-8")) as SpeakersRecord;

  // mic-only / disabled / failed diarization all surface as ok !== true.
  if (record.diarization?.ok !== true) {
    throw new Error("No speakers to rename (diarization disabled, failed, or mic-only session)");
  }

  const segments = record.segments ?? [];
  const entryAssignments = record.entryAssignments ?? [];
  const known = segments.some((s) => s.speaker === speakerId)
    || entryAssignments.some((a) => a.speaker === speakerId);
  if (!known) {
    const available = new Set<string>();
    for (const s of segments) if (s.speaker) available.add(s.speaker);
    for (const a of entryAssignments) if (a.speaker) available.add(a.speaker);
    const sorted = [...available].sort((a, b) => speakerSortKey(a) - speakerSortKey(b));
    throw new Error(`Unknown speaker: ${speakerId}. Available: ${sorted.join(", ")}`);
  }

  const speakerNames: Record<string, string> = record.speakerNames ?? {};

  // `speakerNames` maps canonical id -> current display label. The user may pass
  // either (e.g. after a registry auto-label, the body shows "Женя" and that's
  // what they'll type). Resolve to the canonical id once and key everything off
  // it: the speakerNames write, the speakerRegistry lookup, and the body/footer
  // regex (currentLabel comes from speakerNames[canonicalId]). Without this,
  // renaming by display name silently skips registry propagation and writes a
  // bogus second speakerNames key alongside the canonical one.
  let canonicalId = speakerId;
  for (const [id, label] of Object.entries(speakerNames)) {
    if (label === speakerId) { canonicalId = id; break; }
  }
  const currentLabel = speakerNames[canonicalId] ?? canonicalId;

  const files = (await readdir(meetingDir)).filter((f) => /^transcript.*\.md$/.test(f)).sort();
  const counts: RenameFileCount[] = [];

  for (const file of files) {
    const filePath = join(meetingDir, file);
    const original = await readFile(filePath, "utf-8");

    // `**[HH:MM:SS] LABEL:**` — assembler.ts:41 label token (anchored, no boundary needed).
    const bodyRe = new RegExp(`(\\*\\*\\[\\d{2}:\\d{2}:\\d{2}\\] )${escapeRegex(currentLabel)}(:\\*\\*)`, "g");
    // `- LABEL: ` — talk-time.ts:75 row (anchored by list-marker + ": ").
    const footerRe = new RegExp(`(- )${escapeRegex(currentLabel)}(: )`, "g");

    let bodyMatches = 0;
    let footerMatches = 0;
    let content = original
      .replace(bodyRe, (_m, p1: string, p2: string) => { bodyMatches++; return `${p1}${newName}${p2}`; })
      .replace(footerRe, (_m, p1: string, p2: string) => { footerMatches++; return `${p1}${newName}${p2}`; });

    if (content !== original) await writeAtomic(filePath, content);
    counts.push({ file, bodyMatches, footerMatches, indexMatches: 0 });
  }

  // index.md prose: replace the bare label. `\b` is ASCII-only, so Russian
  // display names get no boundary (e.g. a prior rename to "Женя"). Use
  // Unicode-aware lookarounds so ASCII "Speaker 1" and Cyrillic names both
  // match, while "Speaker 1" never matches inside "Speaker 11".
  const indexPath = join(meetingDir, "index.md");
  if (existsSync(indexPath)) {
    const indexRe = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(currentLabel)}(?![\\p{L}\\p{N}])`, "gu");
    const original = await readFile(indexPath, "utf-8");
    let indexMatches = 0;
    const content = original.replace(indexRe, () => { indexMatches++; return newName; });
    if (content !== original) await writeAtomic(indexPath, content);
    counts.push({ file: "index.md", bodyMatches: 0, footerMatches: 0, indexMatches });
  }

  speakerNames[canonicalId] = newName;
  await writeAtomic(speakersPath, JSON.stringify({ ...record, speakerNames }, null, 2));

  // Propagate the name into the cross-session registry so future meetings
  // auto-apply it. Only when the registry is enabled AND this meeting's
  // speakers.json carries a globalSpeakerId for the canonical id. Fails open.
  // Serialized against concurrent finalize/forget via the global final-pass lock
  // — without it, a background finalize could clobber this rename (or vice versa)
  // because both do load → mutate → save on the same registry file.
  let registryUpdated = false;
  if (options?.speakerRegistryEnabled && options.registryPath) {
    const globalSpeakerId = record.speakerRegistry?.[canonicalId]?.globalSpeakerId;
    if (globalSpeakerId) {
      const locked = acquireGlobalFinalPassLock("<registry-mutation>");
      try {
        if (!locked) {
          throw new Error("registry busy: a final pass is running, retry in a moment");
        }
        const registry = loadRegistry(options.registryPath);
        const entry = registry.speakers.find((s) => s.id === globalSpeakerId);
        if (entry) {
          entry.name = newName;
          await saveRegistry(registry, options.registryPath);
          registryUpdated = true;
        }
      } finally {
        if (locked) releaseGlobalFinalPassLock();
      }
    }
  }

  return { files: counts, registryUpdated };
}
