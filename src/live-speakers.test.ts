import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LiveSpeakerLabeler,
  parseEmbedOutput,
  createLiveSpeakerLabeler,
} from "./live-speakers.js";
import { emptyRegistry, type SpeakerRegistry, type RegistrySpeaker } from "./speaker-registry.js";
import { DEFAULT_CONFIG } from "./types.js";

function basis(i: number, dim = 256): number[] {
  const v = Array<number>(dim).fill(0);
  v[i] = 1;
  return v;
}

// Unit vector at `cosTarget` cosine from basis vector `from`.
function mixAt(cosTarget: number, from: number[], to: number[]): number[] {
  const sin = Math.sqrt(Math.max(0, 1 - cosTarget * cosTarget));
  return from.map((x, i) => x * cosTarget + to[i] * sin);
}

function row(id: string, embedding: number[], extra: Partial<RegistrySpeaker> = {}): RegistrySpeaker {
  return { id, name: null, embedding, backend: "diarizer-manager", createdAt: "x", sourceMeetingId: "m0", matchCount: 0, ...extra };
}

function labelerWith(speakers: RegistrySpeaker[], threshold = 0.7): LiveSpeakerLabeler {
  return new LiveSpeakerLabeler({ version: 1, speakers }, threshold);
}

describe("parseEmbedOutput", () => {
  it("extracts the embedding and tolerates missing fields", () => {
    assert.deepEqual(parseEmbedOutput('{"embedding":[1,2]}').embedding, [1, 2]);
    assert.deepEqual(parseEmbedOutput("{}").embedding, []);
    assert.deepEqual(parseEmbedOutput('{"embedding":"nope"}').embedding, []);
  });
});

describe("LiveSpeakerLabeler.identify (sys)", () => {
  it("returns the registry name on a confident match", () => {
    const l = labelerWith([row("a1", basis(0), { name: "Ann" })]);
    const id = l.identify("sys", mixAt(0.95, basis(0), basis(1)));
    assert.equal(id?.speaker, "Ann");
    assert.equal(id?.matchedName, "Ann");
    assert.equal(id?.globalSpeakerId, "a1");
  });

  it("assigns one stable number per unnamed registry identity across chunks", () => {
    const l = labelerWith([row("a1", basis(0))]);
    const first = l.identify("sys", mixAt(0.9, basis(0), basis(1)));
    const second = l.identify("sys", basis(0));
    assert.equal(first?.speaker, "Speaker 1");
    assert.equal(second?.speaker, "Speaker 1");
  });

  it("numbers distinct identities distinctly", () => {
    const l = labelerWith([row("a1", basis(0)), row("b1", basis(1))]);
    assert.equal(l.identify("sys", basis(0))?.speaker, "Speaker 1");
    assert.equal(l.identify("sys", basis(1))?.speaker, "Speaker 2");
  });

  it("near-threshold chunks borrow the identity's number instead of minting new ones", () => {
    const l = labelerWith([row("a1", basis(0))]);
    // Confident chunk establishes Speaker 1.
    assert.equal(l.identify("sys", basis(0))?.speaker, "Speaker 1");
    // Degraded chunk (0.68 < 0.7 threshold, >= porch) keeps that number.
    const weak = l.identify("sys", mixAt(0.68, basis(0), basis(1)));
    assert.equal(weak?.speaker, "Speaker 1");
    assert.equal(weak?.globalSpeakerId, "a1");
  });

  it("keeps a named identity's label and id for a near-threshold chunk", () => {
    const l = labelerWith([row("a1", basis(0), { name: "Ann" })]);
    const weak = l.identify("sys", mixAt(0.68, basis(0), basis(1)));
    assert.equal(weak?.speaker, "Ann");
    assert.equal(weak?.matchedName, "Ann");
    assert.equal(weak?.globalSpeakerId, "a1");
  });

  it("an unknown voice files a session-local print reused by later chunks", () => {
    const l = labelerWith([]);
    const first = l.identify("sys", basis(5));
    assert.equal(first?.speaker, "Speaker 1");
    const second = l.identify("sys", mixAt(0.99, basis(5), basis(6)));
    assert.equal(second?.speaker, "Speaker 1");
    const other = l.identify("sys", basis(10));
    assert.equal(other?.speaker, "Speaker 2");
  });

  it("ambiguous chunks return null (no label) instead of guessing", () => {
    const e1 = basis(0);
    const e2 = basis(1);
    const l = labelerWith([row("a1", e1), row("b1", e2)]);
    const sample = l2Normalize(e1.map((x, i) => x * 0.75 + e2[i] * 0.73)); // margin ~0.02
    assert.equal(l.identify("sys", sample), null);
  });

  it("returns null for invalid embeddings", () => {
    const l = labelerWith([row("a1", basis(0))]);
    assert.equal(l.identify("sys", [1, 2, 3]), null);
    assert.equal(l.identify("sys", Array(256).fill(0)), null);
  });
});

describe("LiveSpeakerLabeler.identify (mic self split)", () => {
  it("renders confident isSelf matches as Me regardless of name", () => {
    const l = labelerWith([row("self", basis(3), { isSelf: true })]);
    const id = l.identify("mic", basis(3));
    assert.equal(id?.speaker, "Me");
    // A non-self voice still gets numbered.
    assert.equal(l.identify("mic", basis(7))?.speaker, "Speaker 1");
  });

  it("does not treat sys-channel audio as self even when identical", () => {
    const l = labelerWith([row("self", basis(3), { isSelf: true })]);
    const id = l.identify("sys", basis(3));
    assert.notEqual(id?.speaker, "Me");
  });
});

function l2Normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  const d = Math.sqrt(n) || 1;
  return v.map((x) => x / d);
}

describe("createLiveSpeakerLabeler config gates", () => {
  const base = { ...DEFAULT_CONFIG };

  it("returns null when the speaker registry is disabled", () => {
    assert.equal(createLiveSpeakerLabeler({ ...base, speakerRegistryEnabled: false }), null);
  });

  it("returns null when live labels are disabled", () => {
    assert.equal(createLiveSpeakerLabeler({ ...base, speakerRegistryEnabled: true, liveSpeakerLabels: false }), null);
  });

  it("returns a labeler with an empty registry when the file does not exist yet", async () => {
    const l = createLiveSpeakerLabeler({ ...base, speakerRegistryEnabled: true, speakerRegistryPath: "/tmp/meet-nonexistent-registry.json" });
    assert.ok(l instanceof LiveSpeakerLabeler);
  });
});
