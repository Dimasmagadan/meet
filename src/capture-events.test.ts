import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCaptureEvent, parseLegacyChunkFinalized, parseCaptureLine } from "./capture-events.js";

describe("parseCaptureEvent", () => {
  it("parses chunk_finalized event", () => {
    const event = parseCaptureEvent('{"level":"info","event":"chunk_finalized","source":"mic","filename":"mic-001.wav","index":1,"t":1234567890}');
    assert.ok(event);
    if (event && "event" in event) {
      assert.strictEqual(event.event, "chunk_finalized");
    }
  });

  it("parses capture_started event", () => {
    const event = parseCaptureEvent('{"level":"info","event":"capture_started","mode":"full","dir":"/tmp/meet-abc","t":1234567890}');
    assert.ok(event);
  });

  it("parses stream_error event", () => {
    const event = parseCaptureEvent('{"level":"error","event":"stream_error","source":"sys","message":"permission denied","t":1234567890}');
    assert.ok(event);
  });

  it("returns null for non-JSON", () => {
    assert.strictEqual(parseCaptureEvent("not json"), null);
  });

  it("returns null for empty string", () => {
    assert.strictEqual(parseCaptureEvent(""), null);
  });

  it("returns null for JSON without event field", () => {
    assert.strictEqual(parseCaptureEvent('{"level":"info","message":"hi"}'), null);
  });

  it("returns null for JSON without level field", () => {
    assert.strictEqual(parseCaptureEvent('{"event":"started"}'), null);
  });

  it("returns null for non-object JSON", () => {
    assert.strictEqual(parseCaptureEvent('"hello"'), null);
    assert.strictEqual(parseCaptureEvent("42"), null);
    assert.strictEqual(parseCaptureEvent("null"), null);
  });

  it("returns null for chunk_finalized with invalid source", () => {
    const event = parseCaptureEvent('{"level":"info","event":"chunk_finalized","source":"other","filename":"mic-001.wav","index":1,"t":1}');
    assert.strictEqual(event, null);
  });

  it("returns null for chunk_finalized with missing source", () => {
    const event = parseCaptureEvent('{"level":"info","event":"chunk_finalized","filename":"mic-001.wav","index":1,"t":1}');
    assert.strictEqual(event, null);
  });

  it("accepts chunk_finalized with mic source", () => {
    const event = parseCaptureEvent('{"level":"info","event":"chunk_finalized","source":"mic","filename":"mic-001.wav","index":1,"t":1}');
    assert.ok(event);
    assert.strictEqual(event!.event, "chunk_finalized");
  });

  it("accepts chunk_finalized with sys source", () => {
    const event = parseCaptureEvent('{"level":"info","event":"chunk_finalized","source":"sys","filename":"sys-001.wav","index":1,"t":1}');
    assert.ok(event);
    assert.strictEqual(event!.event, "chunk_finalized");
  });
});

describe("parseLegacyChunkFinalized", () => {
  it("parses finalized: mic-001.wav", () => {
    const result = parseLegacyChunkFinalized("finalized: mic-001.wav");
    assert.deepStrictEqual(result, { source: "mic", filename: "mic-001.wav" });
  });

  it("parses finalized: sys-003.wav", () => {
    const result = parseLegacyChunkFinalized("finalized: sys-003.wav");
    assert.deepStrictEqual(result, { source: "sys", filename: "sys-003.wav" });
  });

  it("returns null for non-finalized line", () => {
    assert.strictEqual(parseLegacyChunkFinalized("Mic capture started"), null);
  });

  it("returns null for empty", () => {
    assert.strictEqual(parseLegacyChunkFinalized(""), null);
  });
});

describe("parseCaptureLine", () => {
  it("prefers JSON over legacy", () => {
    const jsonLine = '{"level":"info","event":"chunk_finalized","source":"mic","filename":"mic-001.wav","index":1,"t":1}';
    const result = parseCaptureLine(jsonLine);
    assert.ok(result);
    assert.strictEqual(result!.type, "json");
  });

  it("falls back to legacy parsing", () => {
    const result = parseCaptureLine("finalized: mic-001.wav");
    assert.ok(result);
    assert.strictEqual(result!.type, "legacy");
    if (result!.type === "legacy") {
      assert.strictEqual(result!.finalized.source, "mic");
    }
  });

  it("returns null for unrecognized lines", () => {
    assert.strictEqual(parseCaptureLine("random log message"), null);
  });
});
