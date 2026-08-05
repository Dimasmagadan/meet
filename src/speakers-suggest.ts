import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { formatDuration } from "./talk-time.js";

interface SpeakersRecord {
  talkTime?: { totalSeconds: number; speakers: Array<{ label: string; seconds: number; percent: number }> };
  speakerNames?: Record<string, string>;
  speakerRegistry?: Record<string, { globalSpeakerId: string; matchedName: string | null; score: number }>;
  calendarAttendees?: string[];
}

// Pure formatter over data already on disk (SPEC_CALENDAR_AUTOSTART_2026-08-04 §6.3): talk
// time from talk-time.ts, registry matches/scores from speakerRegistry, and the attendee list
// from §6.1. Deliberately read-only — it prints copy-pasteable `meet rename` lines rather than
// writing anything, since a wrong auto-assignment would mislabel a voice in the cross-session
// registry for every future meeting.
export function buildSuggestion(meetingDir: string, record: SpeakersRecord): string[] {
  const talkTime = record.talkTime;
  if (!talkTime) throw new Error("No talk-time data in this meeting's speakers.json");

  const registry = record.speakerRegistry ?? {};
  const speakerNames = record.speakerNames ?? {};

  // Reverse lookup: a talkTime row whose label was already substituted to a real
  // name at finalize time (registry match) or by a later `meet rename` — lets us
  // annotate those rows with the match confidence instead of re-suggesting them.
  const idByDisplayName = new Map<string, string>();
  for (const [id, meta] of Object.entries(registry)) if (meta.matchedName) idByDisplayName.set(meta.matchedName, id);
  for (const [id, name] of Object.entries(speakerNames)) idByDisplayName.set(name, id);

  const lines: string[] = [];
  const unnamedSpeakerIds: string[] = [];

  for (const row of talkTime.speakers) {
    const duration = formatDuration(row.seconds);
    if (/^Speaker \d+$/.test(row.label)) {
      const meta = registry[row.label];
      let suffix: string;
      if (meta?.matchedName) {
        suffix = `  ← registry: "${meta.matchedName}" (${meta.score.toFixed(2)})`;
      } else {
        suffix = "  ← unnamed";
        unnamedSpeakerIds.push(row.label);
      }
      lines.push(`${row.label.padEnd(10)}${duration}${suffix}`);
    } else {
      const id = idByDisplayName.get(row.label);
      const meta = id ? registry[id] : undefined;
      const suffix = meta ? `  ← registry match (${meta.score.toFixed(2)})` : "";
      lines.push(`${row.label.padEnd(10)}${duration}${suffix}`);
    }
  }

  const attendees = record.calendarAttendees ?? [];
  if (attendees.length > 0) {
    const assignedNames = new Set(
      Object.values(registry)
        .map((m) => m.matchedName)
        .filter((n): n is string => !!n)
        .concat(Object.values(speakerNames)),
    );
    const unassigned = attendees.filter((name) => !assignedNames.has(name));

    lines.push("");
    lines.push(`From calendar: ${attendees.join(", ")}`);
    lines.push(`Unassigned:   ${unassigned.length > 0 ? unassigned.join(", ") : "(none)"}`);

    if (unassigned.length > 0 && unnamedSpeakerIds.length > 0) {
      lines.push("");
      const pool = [...unassigned];
      for (const speakerId of unnamedSpeakerIds) {
        const suggestedName = pool.shift();
        if (!suggestedName) break;
        lines.push(`  meet rename ${meetingDir} "${speakerId}" "${suggestedName}"`);
      }
    }
  }

  return lines;
}

export async function runSpeakersSuggest(meetingDir: string): Promise<string[]> {
  const speakersPath = join(meetingDir, "speakers.json");
  if (!existsSync(speakersPath)) {
    throw new Error(`Not a finalized meeting (no speakers.json in ${meetingDir})`);
  }
  const record = JSON.parse(await readFile(speakersPath, "utf-8")) as SpeakersRecord;
  return buildSuggestion(meetingDir, record);
}
