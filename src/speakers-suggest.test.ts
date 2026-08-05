import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSuggestion } from "./speakers-suggest.js";

describe("buildSuggestion", () => {
  it("annotates a registry-matched speaker and lists an unnamed one, per the spec example", () => {
    const lines = buildSuggestion("~/Meetings/2026-08-05_10-00-weekly-sync", {
      talkTime: {
        totalSeconds: 1600,
        speakers: [
          { label: "Speaker 1", seconds: 1122, percent: 70 },
          { label: "Speaker 2", seconds: 425, percent: 27 },
          { label: "Others", seconds: 72, percent: 3 },
        ],
      },
      speakerRegistry: {
        "Speaker 1": { globalSpeakerId: "g1", matchedName: "Anna Petrova", score: 0.84 },
        "Speaker 2": { globalSpeakerId: "g2", matchedName: null, score: 0.2 },
      },
      calendarAttendees: ["Anna Petrova", "Ivan S.", "Maria K."],
    });

    const text = lines.join("\n");
    assert.ok(text.includes('← registry: "Anna Petrova" (0.84)'));
    assert.ok(text.includes("Speaker 2"));
    assert.ok(text.includes("← unnamed"));
    assert.ok(text.includes("From calendar: Anna Petrova, Ivan S., Maria K."));
    // Anna is already matched — only Ivan/Maria remain unassigned.
    assert.ok(text.includes("Unassigned:   Ivan S., Maria K."));
    // The one unnamed Speaker row gets a suggested rename against the first unassigned attendee.
    assert.ok(text.includes('meet rename ~/Meetings/2026-08-05_10-00-weekly-sync "Speaker 2" "Ivan S."'));
  });

  it("omits the calendar section entirely when the meeting has no attendees", () => {
    const lines = buildSuggestion("/tmp/meeting", {
      talkTime: { totalSeconds: 100, speakers: [{ label: "Speaker 1", seconds: 100, percent: 100 }] },
      speakerRegistry: {},
    });
    assert.ok(!lines.join("\n").includes("From calendar"));
  });

  it("throws when speakers.json has no talk-time data", () => {
    assert.throws(() => buildSuggestion("/tmp/meeting", {}));
  });

  it("does not suggest a rename once every unnamed speaker or every attendee is used up", () => {
    const lines = buildSuggestion("/tmp/meeting", {
      talkTime: {
        totalSeconds: 200,
        speakers: [
          { label: "Speaker 1", seconds: 100, percent: 50 },
          { label: "Speaker 2", seconds: 100, percent: 50 },
        ],
      },
      speakerRegistry: {},
      calendarAttendees: ["Only One"],
    });
    const suggestionLines = lines.filter((l) => l.trim().startsWith("meet rename"));
    assert.strictEqual(suggestionLines.length, 1);
  });
});
