export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Chunk index has no fixed width — Swift's WAVWriter formats it with %03d,
// which pads to at least 3 digits but grows past 1000 for long recordings
// (mic-1000.wav). \d{3} regexes silently stopped matching those chunks.
export const MIC_OR_SYS_CHUNK_RE = /^(mic|sys)-(\d+)\.wav$/;

export function chunkFileRegex(prefix: string, capture = false): RegExp {
  return new RegExp(`^${prefix}-${capture ? "(\\d+)" : "\\d+"}\\.wav$`);
}

// Filenames sort lexicographically ("mic-1000.wav" < "mic-999.wav"), which
// breaks chunk order past index 999. Sort by the numeric index instead —
// order-sensitive callers (e.g. concatenating chunks into one WAV) need this.
export function sortChunkFilenames(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const ai = parseInt(a.match(/(\d+)/)?.[1] ?? "0", 10);
    const bi = parseInt(b.match(/(\d+)/)?.[1] ?? "0", 10);
    return ai - bi;
  });
}
