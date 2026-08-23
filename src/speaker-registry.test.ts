import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadRegistry,
  saveRegistry,
  cosineSimilarity,
  matchSpeaker,
  matchSelf,
  registerSpeaker,
  applyRegistryToSpeakers,
  forgetSpeaker,
  quarantineByBackend,
  emptyRegistry,
  matchesLogPath,
  appendMatchesLog,
  type SpeakerRegistry,
  type RegistrySpeaker,
} from "./speaker-registry.js";

function makeTmpDir(): string {
  const dir = join(tmpdir(), `meet-test-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Two non-collinear unit-ish 256-d vectors with a known cosine.
function vec(seed: number, dim = 256): number[] {
  const v: number[] = [];
  for (let i = 0; i < dim; i++) v.push(((seed * 31 + i * 7) % 101) / 100);
  return v;
}

function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = normalize(vec(1));
    assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-9);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = Array.from({ length: 256 }, (_, i) => i === 0 ? 1 : 0);
    const b = Array.from({ length: 256 }, (_, i) => i === 1 ? 1 : 0);
    assert.ok(Math.abs(cosineSimilarity(a, b)) < 1e-9);
  });

  it("returns 0 when one vector is all-zero (no NaN)", () => {
    assert.equal(cosineSimilarity(Array(256).fill(0), normalize(vec(3))), 0);
  });

  it("rejects differing lengths", () => {
    assert.equal(cosineSimilarity(normalize(vec(1)), normalize(vec(1, 255))), 0);
  });
});

describe("matchSpeaker", () => {
  it("returns the nearest entry above threshold", () => {
    const target = normalize(vec(1));
    const near = normalize(vec(1).map((x) => x + 0.01));
    const far = normalize(vec(99));
    const registry: SpeakerRegistry = {
      version: 1,
      speakers: [
        { id: "far", name: "Far", embedding: far, backend: "diarizer-manager", createdAt: "2026-01-01T00:00:00.000Z", sourceMeetingId: "m0", matchCount: 0 },
        { id: "near", name: "Near", embedding: near, backend: "diarizer-manager", createdAt: "2026-01-02T00:00:00.000Z", sourceMeetingId: "m0", matchCount: 0 },
      ],
    };
    const m = matchSpeaker(target, registry, 0.75, "diarizer-manager");
    assert.equal(m?.speaker.id, "near");
    assert.ok(m!.score >= 0.75);
  });

  it("returns null when best score is below threshold", () => {
    const target = normalize(vec(1));
    const other = normalize(vec(50));
    const registry: SpeakerRegistry = {
      version: 1,
      speakers: [
        { id: "other", name: null, embedding: other, backend: "diarizer-manager", createdAt: "x", sourceMeetingId: "m0", matchCount: 0 },
      ],
    };
    assert.equal(matchSpeaker(target, registry, 0.99, "diarizer-manager"), null);
  });

  it("returns null on an empty registry", () => {
    assert.equal(matchSpeaker(vec(1), emptyRegistry(), 0.5, "diarizer-manager"), null);
  });

  it("is backend-scoped: identical embedding under a different backend does NOT match", () => {
    const v = normalize(vec(1));
    const registry: SpeakerRegistry = {
      version: 1,
      speakers: [
        { id: "vbx", name: "X", embedding: v, backend: "vbx-offline", createdAt: "x", sourceMeetingId: "m0", matchCount: 0 },
      ],
    };
    // Same embedding, but querying as the online backend -> no match.
    assert.equal(matchSpeaker(v, registry, 0.5, "diarizer-manager"), null);
    // Same backend -> matches.
    assert.equal(matchSpeaker(v, registry, 0.5, "vbx-offline")?.speaker.id, "vbx");
  });

  it("never matches a quarantined entry", () => {
    const v = normalize(vec(1));
    const registry: SpeakerRegistry = {
      version: 1,
      speakers: [
        { id: "q", name: "Q", embedding: v, backend: "diarizer-manager", quarantined: true, createdAt: "x", sourceMeetingId: "m0", matchCount: 0 },
      ],
    };
    assert.equal(matchSpeaker(v, registry, 0.5, "diarizer-manager"), null);
  });
});

describe("registerSpeaker", () => {
  it("pushes a new unnamed entry with a stable id and stamps the backend", () => {
    const registry = emptyRegistry();
    const emb = normalize(vec(2));
    const s = registerSpeaker(emb, "meet-abc", registry, "diarizer-manager");
    assert.equal(registry.speakers.length, 1);
    assert.equal(s.name, null);
    assert.equal(s.backend, "diarizer-manager");
    assert.equal(s.sourceMeetingId, "meet-abc");
    assert.equal(s.matchCount, 0);
    assert.ok(s.id.length > 0);
    assert.equal(s.embedding, emb);
    assert.equal(s.isSelf, undefined);
  });

  it("sets isSelf: true only when explicitly requested, omitting the field otherwise", () => {
    const registry = emptyRegistry();
    const s = registerSpeaker(normalize(vec(3)), "meet-abc", registry, "diarizer-manager", () => new Date(), true);
    assert.equal(s.isSelf, true);
  });
});

describe("matchSelf", () => {
  it("matches only isSelf-flagged entries, ignoring regular ones above the same threshold", () => {
    const target = normalize(vec(1));
    const near = normalize(vec(1).map((x) => x + 0.01));
    const registry: SpeakerRegistry = {
      version: 1,
      speakers: [
        { id: "regular", name: null, embedding: near, backend: "diarizer-manager", createdAt: "x", sourceMeetingId: "m0", matchCount: 0 },
      ],
    };
    assert.equal(matchSelf(target, registry, 0.75, "diarizer-manager"), null);

    registry.speakers.push({ id: "self", name: null, embedding: near, isSelf: true, backend: "diarizer-manager", createdAt: "x", sourceMeetingId: "m0", matchCount: 0 });
    const m = matchSelf(target, registry, 0.75, "diarizer-manager");
    assert.equal(m?.speaker.id, "self");
  });

  it("is backend-scoped and never matches a quarantined self entry", () => {
    const v = normalize(vec(1));
    const registry: SpeakerRegistry = {
      version: 1,
      speakers: [
        { id: "self-other-backend", name: null, embedding: v, isSelf: true, backend: "vbx-offline", createdAt: "x", sourceMeetingId: "m0", matchCount: 0 },
        { id: "self-quarantined", name: null, embedding: v, isSelf: true, quarantined: true, backend: "diarizer-manager", createdAt: "x", sourceMeetingId: "m0", matchCount: 0 },
      ],
    };
    assert.equal(matchSelf(v, registry, 0.5, "diarizer-manager"), null);
  });
});

describe("applyRegistryToSpeakers", () => {
  it("registers fresh voices on first meeting (no overrides, unnamed)", () => {
    const registry = emptyRegistry();
    const emb1 = normalize(vec(1));
    const emb2 = normalize(vec(2));
    const embs = new Map([["Speaker 1", emb1], ["Speaker 2", emb2]]);

    const res = applyRegistryToSpeakers(embs, "meet-a", registry, 0.75, "diarizer-manager");

    assert.equal(registry.speakers.length, 2);
    assert.equal(res.labelOverrides.size, 0);
    assert.equal(res.speakerMeta.size, 2);
    assert.equal(res.speakerMeta.get("Speaker 1")!.fresh, true);
    assert.equal(res.speakerMeta.get("Speaker 1")!.matchedName, null);
    assert.equal(res.matches.length, 2);
  });

  it("re-matching the same embedding bumps matchCount and does not duplicate", () => {
    const registry = emptyRegistry();
    const emb = normalize(vec(1));
    const embs = () => new Map([["Speaker 1", emb]]);

    applyRegistryToSpeakers(embs(), "meet-a", registry, 0.75, "diarizer-manager");
    applyRegistryToSpeakers(embs(), "meet-b", registry, 0.75, "diarizer-manager");

    assert.equal(registry.speakers.length, 1);
    assert.equal(registry.speakers[0].matchCount, 1);
  });

  it("two meetings with the same voice: second auto-labels with the first's name after rename", () => {
    const registry = emptyRegistry();
    const emb = normalize(vec(1));
    const embs = () => new Map([["Speaker 1", emb]]);

    // Meeting 1: voice V registers unnamed.
    applyRegistryToSpeakers(embs(), "meet-a", registry, 0.75, "diarizer-manager");
    // Simulate `meet rename` writing a name into the registry entry.
    registry.speakers[0].name = "Женя";

    // Meeting 2: same voice -> match -> auto-applies the name.
    const res = applyRegistryToSpeakers(embs(), "meet-b", registry, 0.75, "diarizer-manager");

    assert.equal(res.labelOverrides.get("Speaker 1"), "Женя");
    assert.equal(res.speakerMeta.get("Speaker 1")!.matchedName, "Женя");
    assert.equal(res.speakerMeta.get("Speaker 1")!.fresh, false);
    assert.equal(registry.speakers[0].matchCount, 1);
  });

  it("backend flip: prior-backend entries get quarantined and the same voice re-registers fresh", () => {
    const registry = emptyRegistry();
    const emb = normalize(vec(1));
    const embs = () => new Map([["Speaker 1", emb]]);

    // Register under the online backend.
    applyRegistryToSpeakers(embs(), "meet-a", registry, 0.75, "diarizer-manager");
    const oldId = registry.speakers[0].id;

    // Flip backend: quarantine all diarizer-manager entries.
    const n = quarantineByBackend(registry, "diarizer-manager");
    assert.equal(n, 1);
    assert.equal(registry.speakers[0].quarantined, true);

    // Same voice, now under vbx-offline, must NOT match the quarantined entry.
    const res = applyRegistryToSpeakers(embs(), "meet-b", registry, 0.75, "vbx-offline");
    assert.equal(res.speakerMeta.get("Speaker 1")!.fresh, true);
    assert.notEqual(res.speakerMeta.get("Speaker 1")!.globalSpeakerId, oldId);
    assert.equal(registry.speakers.length, 2);
  });

  it("does not collapse two same-run speakers that both match one named entry", () => {
    // Realistic failure mode: two diarized speakers happen to clear threshold
    // against the same pre-existing named entry. Without the claimed-set guard,
    // both inherit "Alex" and the same globalSpeakerId, collapsing two voices
    // diarization had asserted were distinct. Map iteration is insertion order,
    // so "Speaker 1" processes first.
    const registry = emptyRegistry();
    const existing = normalize(vec(1));
    registry.speakers.push({
      id: "existing", name: "Alex", embedding: existing, backend: "diarizer-manager",
      createdAt: "2026-01-01T00:00:00.000Z", sourceMeetingId: "m0", matchCount: 0,
    });
    const emb1 = normalize(vec(1).map((x) => x + 0.001));   // cos ≈ 1.0 with existing
    const emb2 = normalize(vec(1).map((x) => x + 0.002));   // cos ≈ 1.0 with existing
    const embs = new Map([["Speaker 1", emb1], ["Speaker 2", emb2]]);

    const res = applyRegistryToSpeakers(embs, "meet-a", registry, 0.75, "diarizer-manager");

    assert.equal(res.labelOverrides.size, 1);
    assert.equal(res.labelOverrides.get("Speaker 1"), "Alex");
    assert.equal(res.speakerMeta.get("Speaker 1")!.globalSpeakerId, "existing");
    // Speaker 2 must NOT have matched the same identity — registers fresh.
    assert.equal(res.speakerMeta.get("Speaker 2")!.fresh, true);
    assert.notEqual(res.speakerMeta.get("Speaker 2")!.globalSpeakerId, "existing");
    assert.equal(registry.speakers.length, 2);
  });

  it("seedExcludeIds keeps a cluster from matching a pre-excluded entry (e.g. the recording user's own isSelf voiceprint)", () => {
    // Mirrors runMicDiarizationStep: the "other speaker" matching pass must
    // never be able to match the self entry, even if cosine clears threshold
    // (which shouldn't normally happen, but defense in depth).
    const registry = emptyRegistry();
    const selfEntry = registerSpeaker(normalize(vec(1)), "meet-a", registry, "diarizer-manager", () => new Date(), true);
    const closeToSelf = normalize(vec(1).map((x) => x + 0.001)); // cos ≈ 1.0 with selfEntry
    const embs = new Map([["Speaker 1", closeToSelf]]);

    const res = applyRegistryToSpeakers(embs, "meet-b", registry, 0.75, "diarizer-manager", () => new Date(), new Set([selfEntry.id]));

    assert.equal(res.speakerMeta.get("Speaker 1")!.fresh, true);
    assert.notEqual(res.speakerMeta.get("Speaker 1")!.globalSpeakerId, selfEntry.id);
    assert.equal(registry.speakers.length, 2);
  });

  it("does not match a speaker against a fresh same-run registration", () => {
    // Empty registry, two near-identical embeddings (cos > threshold). Without
    // the guard, Speaker 2 would match Speaker 1's just-registered entry. The
    // guard prevents same-run matches even on registrations, not just on
    // matches against pre-existing entries.
    const registry = emptyRegistry();
    const emb1 = normalize(vec(1));
    const emb2 = normalize(vec(1).map((x) => x + 0.001));   // cos ≈ 1.0 with emb1
    const embs = new Map([["Speaker 1", emb1], ["Speaker 2", emb2]]);

    const res = applyRegistryToSpeakers(embs, "meet-a", registry, 0.75, "diarizer-manager");

    assert.equal(res.speakerMeta.get("Speaker 1")!.fresh, true);
    assert.equal(res.speakerMeta.get("Speaker 2")!.fresh, true);
    assert.notEqual(
      res.speakerMeta.get("Speaker 1")!.globalSpeakerId,
      res.speakerMeta.get("Speaker 2")!.globalSpeakerId,
    );
    assert.equal(registry.speakers.length, 2);
  });
});

describe("forgetSpeaker", () => {
  it("drops the entry with the matching id", () => {
    const registry = emptyRegistry();
    const s = registerSpeaker(normalize(vec(1)), "m", registry, "diarizer-manager");
    assert.equal(forgetSpeaker(registry, s.id), true);
    assert.equal(registry.speakers.length, 0);
  });

  it("returns false for an unknown id", () => {
    assert.equal(forgetSpeaker(emptyRegistry(), "nope"), false);
  });

  it("a forgotten voice re-registers fresh on the next finalize", () => {
    const registry = emptyRegistry();
    const emb = normalize(vec(1));
    const embs = () => new Map([["Speaker 1", emb]]);
    const r1 = applyRegistryToSpeakers(embs(), "m1", registry, 0.75, "diarizer-manager");
    forgetSpeaker(registry, r1.speakerMeta.get("Speaker 1")!.globalSpeakerId);
    const r2 = applyRegistryToSpeakers(embs(), "m2", registry, 0.75, "diarizer-manager");
    assert.equal(r2.speakerMeta.get("Speaker 1")!.fresh, true);
  });
});

describe("registry persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("loadRegistry returns empty when the file is missing", () => {
    const reg = loadRegistry(join(dir, "registry.json"));
    assert.deepEqual(reg, emptyRegistry());
  });

  it("loadRegistry returns empty on corrupt JSON", () => {
    const path = join(dir, "registry.json");
    writeFileSync(path, "{not json", "utf-8");
    assert.deepEqual(loadRegistry(path), emptyRegistry());
  });

  it("saveRegistry -> loadRegistry round-trips speakers", async () => {
    const path = join(dir, "registry.json");
    const reg = emptyRegistry();
    registerSpeaker(normalize(vec(1)), "m1", reg, "diarizer-manager");
    await saveRegistry(reg, path);
    const loaded = loadRegistry(path);
    assert.equal(loaded.speakers.length, 1);
    assert.equal(loaded.speakers[0].backend, "diarizer-manager");
  });

  it("saveRegistry -> loadRegistry round-trips isSelf", async () => {
    const path = join(dir, "registry.json");
    const reg = emptyRegistry();
    registerSpeaker(normalize(vec(1)), "m1", reg, "diarizer-manager", () => new Date(), true);
    await saveRegistry(reg, path);
    const loaded = loadRegistry(path);
    assert.equal(loaded.speakers[0].isSelf, true);
  });

  it("saveRegistry is idempotent on re-run (atomic write, no duplication)", async () => {
    const path = join(dir, "registry.json");
    const reg = emptyRegistry();
    registerSpeaker(normalize(vec(1)), "m1", reg, "diarizer-manager");
    await saveRegistry(reg, path);
    await saveRegistry(reg, path);
    const loaded = loadRegistry(path);
    assert.equal(loaded.speakers.length, 1);
  });

  it("loadRegistry drops entries with non-array/empty embeddings or missing id/backend", () => {
    // A hand-edited or partially-corrupt registry: validate per-entry at load
    // so cosineSimilarity never sees a null embedding and `meet speakers list`
    // keeps working. The good row survives; every malformed row is dropped.
    const path = join(dir, "registry.json");
    const raw = {
      version: 1,
      speakers: [
        { id: "good", name: null, embedding: normalize(vec(1)), backend: "diarizer-manager", createdAt: "x", sourceMeetingId: "m", matchCount: 0 },
        { id: "null-emb", name: null, embedding: null, backend: "diarizer-manager", createdAt: "x", sourceMeetingId: "m", matchCount: 0 },
        { id: "missing-emb", name: null, backend: "diarizer-manager", createdAt: "x", sourceMeetingId: "m", matchCount: 0 },
        { name: null, embedding: [0.1], backend: "diarizer-manager" },
        { id: "empty-emb", name: null, embedding: [], backend: "diarizer-manager" },
        { id: "no-backend", name: null, embedding: [0.1] },
      ],
    };
    writeFileSync(path, JSON.stringify(raw), "utf-8");

    const loaded = loadRegistry(path);
    assert.equal(loaded.speakers.length, 1);
    assert.equal(loaded.speakers[0].id, "good");
  });
});

describe("matches.log", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTmpDir();
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("matchesLogPath sits next to the registry file", () => {
    assert.equal(matchesLogPath(join(dir, "registry.json")), join(dir, "matches.log"));
  });

  it("appendMatchesLog appends lines without overwriting", async () => {
    const path = join(dir, "matches.log");
    await appendMatchesLog(path, ["line one", "line two"]);
    await appendMatchesLog(path, ["line three"]);
    const content = readFileSync(path, "utf-8");
    assert.match(content, /line one\nline two\nline three\n/);
  });

  it("appendMatchesLog is a no-op for an empty list (does not create the file)", async () => {
    const path = join(dir, "matches.log");
    await appendMatchesLog(path, []);
    assert.equal(existsSync(path), false);
  });
});
