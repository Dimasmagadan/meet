import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWhisperHelp, detectWhisperCompute, _resetComputeCache, type WhisperComputeInfo } from "./compute-device.js";

// Captured `whisper-cli --help` stderr from the brew `ggml` 0.13.1 build on an
// Apple M2 Pro. This build writes the option list AND the backend-init log to
// stderr (stdout is empty) and advertises NO `--metal`/`-ngl` runtime flag —
// Metal is auto-loaded via backend auto-detection. This fixture pins that
// Swift/brew → Node contract without spawning the binary in CI.
const REAL_HELP_STDERR = `load_backend: loaded BLAS backend from /opt/homebrew/Cellar/ggml/0.13.1/libexec/libggml-blas.so
ggml_metal_device_init: tensor API disabled for pre-M5 and pre-A19 devices
ggml_metal_library_init: using embedded metal library
ggml_metal_library_init: loaded in 0.033 sec
ggml_metal_device_init: GPU name:   MTL0 (Apple M2 Pro)
ggml_metal_device_init: GPU family: MTLGPUFamilyApple8  (1008)
load_backend: loaded MTL backend from /opt/homebrew/Cellar/ggml/0.13.1/libexec/libggml-metal.so
load_backend: loaded CPU backend from /opt/homebrew/Cellar/ggml/0.13.1/libexec/libggml-cpu-apple_m2_m3.so
usage: whisper-cli [options] file0 file1 ...
supported audio formats: flac, mp3, ogg, wav

options:
  -h,        --help                 [default] show this help message and exit
  -t N,      --threads N            [4      ] number of threads to use during computation
  -m FNAME,  --model FNAME          [       ] model path
  -f FNAME,  --file FNAME           [       ] input WAV file path
  -otxt,     --output-txt           [false  ] output result in a text file
  -oj,       --output-json          [false  ] output result in a JSON file
  -of FNAME, --output-file FNAME    [       ] output file path (without file extension)
  -np,       --no-prints            [false  ] do not print anything other than the results
`;

const EMPTY: WhisperComputeInfo = {
  metalFlagSupported: false,
  metalActive: false,
  gpuName: null,
  backendLines: [],
};

describe("parseWhisperHelp", () => {
  it("detects Metal active and parses GPU name from a real brew build's help stderr", () => {
    const info = parseWhisperHelp(REAL_HELP_STDERR);
    assert.strictEqual(info.metalActive, true);
    assert.strictEqual(info.metalFlagSupported, false, "this build advertises no --metal flag");
    assert.strictEqual(info.gpuName, "Apple M2 Pro");
    assert.strictEqual(info.backendLines.length, 3);
    assert.ok(info.backendLines.some((l) => /loaded MTL backend/.test(l)));
    assert.ok(info.backendLines.some((l) => /loaded CPU backend/.test(l)));
  });

  it("detects a --metal flag when the build advertises it", () => {
    const help = `options:
  --metal            [true] use Metal GPU acceleration
  -m FNAME --model FNAME
`;
    const info = parseWhisperHelp(help);
    assert.strictEqual(info.metalFlagSupported, true);
    assert.strictEqual(info.metalActive, false);
  });

  it("detects the older -ngl / --ngl GPU-layer flag alias", () => {
    assert.strictEqual(parseWhisperHelp("  -ngl N  number of GPU layers").metalFlagSupported, true);
    assert.strictEqual(parseWhisperHelp("  --ngl N  number of GPU layers").metalFlagSupported, true);
  });

  it("does NOT treat --no-metal (disable form) as flag support", () => {
    const help = `options:
  --no-metal         [false] disable Metal GPU acceleration
`;
    assert.strictEqual(parseWhisperHelp(help).metalFlagSupported, false);
  });

  it("falls back to the raw GPU-name string when no parens are present", () => {
    const help = "ggml_metal_device_init: GPU name:   MTLDevice\nload_backend: loaded MTL backend from x\n";
    const info = parseWhisperHelp(help);
    assert.strictEqual(info.metalActive, true);
    assert.strictEqual(info.gpuName, "MTLDevice");
  });

  it("reports CPU / no-metal when no MTL backend line exists", () => {
    const help = `load_backend: loaded CPU backend from x
options:
  -h --help
`;
    const info = parseWhisperHelp(help);
    assert.strictEqual(info.metalActive, false);
    assert.strictEqual(info.gpuName, null);
    assert.strictEqual(info.backendLines.length, 1);
  });

  it("returns empty info on empty / non-help input", () => {
    assert.deepStrictEqual(parseWhisperHelp(""), { ...EMPTY });
    assert.deepStrictEqual(parseWhisperHelp("not a help message at all, just words"), { ...EMPTY });
  });
});

describe("detectWhisperCompute cache + fail-open", () => {
  it("fail-opens to empty info when the binary path does not exist", async () => {
    _resetComputeCache();
    const info = await detectWhisperCompute("/nonexistent/whisper-cli-binary-xyz");
    assert.deepStrictEqual(info, { ...EMPTY });
  });

  it("caches the result per binary path across calls", async () => {
    _resetComputeCache();
    const a = await detectWhisperCompute("/nonexistent/whisper-cli-binary-abc");
    const b = await detectWhisperCompute("/nonexistent/whisper-cli-binary-abc");
    // Same reference — cache returned the memoized object, no re-probe.
    assert.strictEqual(a, b);
  });

  it("re-probes when the binary path changes", async () => {
    _resetComputeCache();
    const a = await detectWhisperCompute("/nonexistent/whisper-cli-one");
    const b = await detectWhisperCompute("/nonexistent/whisper-cli-two");
    assert.notStrictEqual(a, b);
  });
});
