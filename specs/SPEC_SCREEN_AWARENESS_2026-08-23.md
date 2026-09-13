# SDD Spec: Local Screen Awareness

**Date:** 2026-08-23
**Status:** Draft - pre-implementation
**Owner:** Dmitrii Diakonov
**External reference:** [Raycast v0.71 Screen Awareness, 2026-08-19](https://www.raycast.com/changelog/macos-beta/0-71)

---

## 1. Overview

Screen Awareness lets a user attach useful context from the focused macOS
window to an active `meet` recording or Ask AI request. The feature must remain
fully local: no screenshots, extracted text, or meeting context leave the Mac
unless the user has independently configured an external model provider.

The user-facing value is avoiding manual copy/paste before asking questions
such as:

- "What from the requirements on screen has not been discussed?"
- "Summarize this document in the context of the current call."
- "Draft a reply to the open email using the decisions from this meeting."
- "Add unfamiliar terms from this document to the meeting vocabulary."

The initial design deliberately favors structured UI text and Apple Vision OCR
over image understanding. A local visual language model (VLM) is an explicit,
manual fallback for diagrams, canvases, mockups, and images where text alone is
not enough.

## 2. Goals

- Keep capture, OCR, storage, and inference local by default.
- Work on an Apple Silicon MacBook Pro M2 Pro with 16 GB unified memory without
  interrupting audio capture or causing persistent memory pressure.
- Let a user explicitly attach text, a file, OCR output, or visual analysis to
  a live meeting.
- Reuse the existing Notch Ask AI and Cheat Sheet concepts instead of creating a
  second long-lived UI surface.
- Preserve a reviewable per-meeting context trail for the final index and later
  questions, without retaining screenshots by default.
- Make heavy visual inference cooperative with final retranscription,
  diarization, and Parakeet comparison passes.

## 3. Non-goals

- No continuous screen recording, periodic screenshots, keylogging, or passive
  cross-application activity timeline.
- No cloud OCR, cloud VLM, upload, share links, account, or team workspace.
- No bypassing macOS TCC permission controls.
- No automatic capture merely because a meeting is recording.
- No generic desktop agent that can click, type, or act in another application.
- No promise that Accessibility text faithfully represents arbitrary custom,
  browser-canvas, terminal, or GPU-rendered applications.
- No requirement to run a large VLM continuously in memory.

## 4. Product Decisions

### 4.1 Capture is explicit and user initiated

The user invokes a capture through the menu bar / Notch panel or a CLI command.
The system never captures the active window automatically. This is essential
both for privacy and for predictable resource use.

Proposed CLI surface:

```bash
meet context capture                 # Accessibility text; offers OCR fallback if needed
meet context capture --ocr           # Screenshot and local Apple Vision OCR
meet context capture --visual        # Screenshot and local VLM analysis
meet context add --file notes.md     # Attach a local text-like file
meet context add --stdin             # Attach piped or pasted text
meet context show                    # Show active meeting context items
meet context clear                   # Remove active meeting context items
```

Exact command naming can change during implementation, but capture modality
must remain visible and explicit. `--visual` must never silently fall back to a
remote provider.

### 4.2 Text-first cascade

The default capture sequence is:

```text
Focused window
  |
  +-- Accessibility API (AXUIElement) -> text, app/window metadata
  |
  +-- no usable text -> user confirms OCR fallback -> ScreenCaptureKit screenshot
  |                                      -> Apple Vision OCR -> text
  |
  +-- --visual only -> reduced screenshot -> local VLM -> visual description
  |
  +-- normalized context item -> active session context store -> Ask AI/index
```

Accessibility text is preferred because it is fast, accurate for native
controls, and does not need image retention. OCR is a fallback for apps that do
not expose useful accessibility content, but it requires a separate confirmation
because it can request Screen Recording permission. `meet context capture --ocr`
is itself that explicit confirmation. VLM inference is reserved for a user who
specifically needs visual interpretation.

### 4.3 No screenshot persistence by default

The durable meeting artifact is text and metadata, not an image. A context item
may retain:

```json
{
  "id": "ctx_...",
  "capturedAt": "2026-08-23T12:34:56.000Z",
  "kind": "accessibility | ocr | visual | file | stdin",
  "app": "Safari",
  "windowTitle": "Requirements",
  "text": "...",
  "summary": "...",
  "sourcePath": null
}
```

The raw screenshot is kept only in a private temporary directory while OCR/VLM
is running, then deleted in `finally`. A future user-controlled
`retainContextImages` option may preserve an image next to the meeting, but it
is not part of the first release and must default to `false`.

### 4.4 Existing meeting features remain the source of truth

- `context.md` is a human-readable rendering of the accepted context next to an
  active session and later in the finalized meeting output directory.
- A structured `context.jsonl` is the machine-readable counterpart.
- `meet ask` supplies current context items alongside the transcript only when
  the answering provider is verified local (Sections 5.2 and 8.3). When
  `meet ask` is backed by a cloud-configured `opencode` and no local model is
  available, it answers from the transcript alone, withholds the context, and
  states both in the answer.
- The optional `opencodeIndexPass` supplies finalized `context.md` to
  `runOpencodeIndex()` only when its provider is verified local. Otherwise it
  indexes the transcript without Screen Awareness context and reports why;
  context must never be handed to a cloud-configured `opencode` provider by
  default. Context is auxiliary material, never a replacement for the
  transcript.
- The existing `vocabulary.json` remains authoritative. A user may explicitly
  promote selected captured terms into it; capture must not change vocabulary
  automatically.
- `SPEC_NOTCH_CHEATSHEET_2026-08-12.md` remains the low-cost read-only
  reference-context path. It should land before, or independently of, this
  feature.

## 5. Local Runtime Choices

### 5.1 Extraction and OCR

| Need | Local implementation | Permission |
|---|---|---|
| Native text and window metadata | Accessibility `AXUIElement` | Accessibility |
| Window image | `SCScreenshotManager` window capture (macOS 14+) | Screen Recording |
| OCR | `Vision.framework` `VNRecognizeTextRequest` with configured recognition language | None beyond image access |
| Meeting audio | Existing Core Audio process tap | Existing system-audio TCC path |

Screen awareness must not alter the existing system-audio capture path. In
particular, Core Audio process taps currently avoid Screen Recording permission;
only the optional image capture path introduces Screen Recording TCC.

### 5.2 Local text models

Suitable local text-model classes for this machine are 3B-8B parameter models
in 4-bit quantization, run through MLX, llama.cpp, or a strictly local Ollama
installation. Candidates include Qwen 3 4B/8B, Llama 3.x 8B, and Gemma 3 4B.

The implementation needs a small provider seam, for example:

```ts
interface LocalContextModel {
  summarize(input: ContextItem[], question?: string): Promise<string>;
  isAvailable(): Promise<boolean>;
}
```

No provider is selected by default in this spec. `meet doctor` should report
whether the configured local binary and model are available, but must not
download a multi-gigabyte model automatically. When no local provider is
available, Ask AI must retain the accepted context but clearly state that local
analysis is unavailable; it must not fall back to `opencode` or another remote
provider.

### 5.3 Local visual models

For manual image analysis, use a 3B-7B VLM in 4-bit quantization, such as
Qwen2.5-VL 3B/7B, Gemma 3 4B, or MiniCPM-V. The model process is short-lived or
idle-unloaded; it must not stay resident throughout recording.

Before inference, resize the image to a maximum long edge of roughly
1280-1600 pixels. The VLM gets a task-specific prompt to describe only useful
facts, visible controls, diagram labels, or open questions. It should not
invent inaccessible text.

## 6. M2 Pro 16 GB Feasibility

An M2 Pro with 16 GB unified memory is sufficient for the intended local-first
implementation if the default path is Accessibility/OCR plus a 3B-8B quantized
text model and visual inference remains on-demand.

| Workload | Expected fit on M2 Pro 16 GB |
|---|---|
| Accessibility extraction and Apple Vision OCR | Comfortable |
| 3B-4B Q4 text model | Comfortable during recording |
| 7B-8B Q4 text model | Usable on demand; monitor memory pressure |
| 3B-7B Q4 VLM, one screenshot | Usable on demand |
| 12B Q4 model with active recording | Borderline |
| 20B+ model or continuous VLM | Out of scope / impractical |

Indicative performance, to verify on the target machine rather than promise:

- Accessibility extraction: near-instant for cooperative apps.
- OCR: roughly 0.2-1.5 seconds for a focused window.
- 3B-4B text model: commonly 10-30 tokens/second.
- 7B-8B text model: commonly 7-20 tokens/second.
- One local VLM screenshot analysis: commonly 2-10 seconds.

The final pass can already load the medium Whisper model, AudioAnalysis, and
diarization resources. A VLM must therefore be serialized with heavy passes.
Live capture integrity always wins over context latency.

## 7. Scheduling and Resource Policy

1. Accessibility extraction and Apple Vision OCR may run during recording.
2. Small text-model requests may run during recording only when the existing
   system-pressure check reports acceptable headroom.
3. VLM requests enter a bounded local queue and are never concurrent with
   final retranscription, diarization, or Parakeet comparison.
4. If pressure is high, keep the captured text and show `Context captured;
   local analysis waiting for resources` rather than dropping it.
5. A model process is terminated or unloaded after a configurable idle period.
6. Capture/transcription cannot be blocked by a model process. The policy must
   preserve the existing invariant: audio capture has priority over live text.
7. The model queue is bounded; when full, reject the newest visual analysis with
   a clear message while retaining no screenshot unless the user retries.

The existing `system-monitor.ts`, `whenNotOverloaded()`, `makeDeadline()`, and
`taskpolicy -c utility` conventions are the preferred integration points. The
live transcription path remains ungated; this new optional workload, unlike
live transcription, may wait or fail closed because it never contains unique
audio data.

## 8. Privacy, Security, and Permissions

### 8.1 Permission model

- Accessibility is requested only when the user invokes a text capture and it
  has not been granted.
- Screen Recording is requested only for OCR/image capture after an explicit
  user action or an explicit in-flow confirmation after Accessibility capture
  finds no usable text. This must be documented separately from the process-tap
  audio permission behavior in `SPEC_TCC_SCREEN_REPROMPT_2026-07-31.md`.
- No permission prompt may be initiated by a timer, auto-start callback, or
  background finalizer.

### 8.2 User review and application exclusions

Before durable attachment, show a compact preview containing application name,
window title, capture mode, and extracted text/visual summary. The user can
discard it. The initial menu-bar flow can use an `NSAlert` or Notch confirmation;
it need not build a full editor.

Add a configurable denylist of bundle identifiers. The initial release must
ship a conservative, versioned, and tested list of known password-manager bundle
identifiers; it must not claim to cover financial applications generally. Meet's
own menu-bar bundle is always excluded. A denylist is defense in depth, not a
guarantee. On a denied app, explain that the window was not captured and offer
`meet context add --file` as a deliberate alternative.

### 8.3 Local-only guarantee

The local provider process must be invoked directly with a local model path or
via a configured provider whose endpoint is verified loopback-only. This same
check applies before passing context to `runOpencodeIndex()`. If the existing
`opencode` integration points to a cloud provider, Screen Awareness must not
send its context to it by default. Any later cloud handoff needs a separate,
conspicuous opt-in configuration and documentation.

Temporary screenshots and model inputs live under `~/.meet` with private
permissions and are removed after use. Context text is inherently sensitive;
the review UI must state that it will be stored with the meeting if accepted.

## 9. UX

### 9.1 Notch panel

The notch today has two implemented modes, Transcript and Ask AI
(`NotchPanelController.swift`); the Cheat Sheet tab is planned
(`SPEC_NOTCH_CHEATSHEET_2026-08-12.md`) but not yet implemented. When it lands,
the three modes remain coherent:

```text
Transcript | Ask AI | Cheat Sheet
```

Screen Awareness is an action available from Ask AI, not a permanent fourth
tab. Proposed controls:

- `Attach focused window text`
- `OCR focused window`
- `Analyze focused window visually`
- `Show attached context`

Ask AI visibly states how many context items it will use and whether local
analysis is available. A question can be asked against the transcript alone,
context alone, or both; transcript plus context is the default when context
items are attached. When the provider is cloud-configured and no local model
is available, Ask AI answers from the transcript alone, withholds the context,
and says so in the answer (Sections 5.2 and 8.3).

### 9.2 Menu bar

While recording, add a `Capture Context` submenu:

- `Focused Window Text`
- `Focused Window OCR`
- `Analyze Visually...`
- `Attach File...`
- `Show Context`

Visual analysis must be labeled as slower and local-model-dependent. A busy
state shows that capture succeeded separately from whether analysis is pending.

### 9.3 CLI

CLI output must include capture method and whether the result was persisted:

```text
Context captured from Safari / Requirements (Accessibility): 2,431 chars
Visual analysis queued; waiting for final pass resources
```

It must not print extracted sensitive content to the terminal by default.

## 10. Data Layout

During recording:

```text
~/.meet/sessions/meet-<id>/
  context.jsonl
  context.md
  context-tmp/          # private, ephemeral screenshots only
```

After finalization:

```text
~/Meetings/<meeting>/
  transcript.md
  index.md
  meta.md
  context.md
  context.jsonl
```

The finalizer moves only accepted text and structured metadata. If no context
was accepted, it creates neither final context file. `context.jsonl` is the
authoritative durable representation; `context.md` is regenerated from it when
needed, so a crash between their writes cannot corrupt the source of truth.

The finalizer owns the transfer after acquiring `finalizer.lock`. Context
capture is accepted only while the live recorder process still owns the
session: `active-recording.lock` points at this session with a live PID. Gate
on that, never on the `session.status` string alone — `paused` has two writers
(user pause in `recorder.ts`; a background finalizer waiting for an active
recording in `finalize.ts`), and user resume does not currently restore
`recording`, so a status-only check can accept appends while the finalizer
owns the session and misclassify a live user-paused one. Once the recorder
exits and finalization begins, `meet context` and UI actions fail with a clear
message rather than append concurrently. Startup and finalization sweep stale
`context-tmp/` directories before processing any new capture or transferring
artifacts, including after an unclean exit.

## 11. Implementation Plan

### Phase 1: Explicit text and file context

- Add append/read helpers for authoritative `context.jsonl`, plus a renderer for
  `context.md` with atomic replacement semantics.
- Add `meet context add --file`, `--stdin`, `show`, and `clear`.
- Pass accepted context to `meet ask` and to optional index generation only
  after verifying its provider is local.
- Add Notch/Menu Bar file/text attachment affordance.
- Update the CLI reference and feature documentation in `README.md`, `docs/`,
  and `docs/ru/` using the matching named marker blocks.
- No Accessibility, ScreenCaptureKit, OCR, or model dependency yet.

### Phase 2: Accessibility capture

- Add a small Swift helper that receives an explicit capture request and reads
  focused-app/window metadata plus supported `AXUIElement` text.
- Return a structured result to Node through existing short-lived CLI/file IPC
  patterns; do not create a persistent socket service.
- Add review/discard before appending the result.
- Add settings and `meet doctor` diagnostics for Accessibility permission.
- Resolve Accessibility trust and signing for the helper per
  `SPEC_TCC_SIGNING_2026-07-31.md` (ad-hoc signatures lose the TCC grant on
  every rebuild).

### Phase 3: ScreenCaptureKit plus Apple Vision OCR

- Add explicit focused-window screenshot capture.
- Require macOS 14+ for `SCScreenshotManager`; report an unsupported-platform
  diagnostic rather than falling back to display capture.
- Run `VNRecognizeTextRequest` locally with the configured meeting language
  (including `ru-RU` for the default Russian setup), then immediately delete
  the source image.
- Add Screen Recording permission guidance that distinguishes this feature from
  the Core Audio process-tap permissions.
- Add denylist behavior and image resizing.

### Phase 4: Local model provider and visual analysis

- Define the local-model provider seam and implement one local backend first.
- Add resource queueing using `system-monitor.ts` and exclusive heavy-work
  coordination with final passes.
- Add manual `--visual` VLM analysis and model lifecycle/unload policy.
- Record model/backend/version in context metadata for diagnosis, not in public
  transcript content unless the user asks.

### Phase 5: Context-assisted vocabulary and post-meeting workflows

- Suggest terms from an accepted context item; require explicit confirmation
  before writing existing `vocabulary.json`.
- Allow the final index prompt to cite relevant context items distinctly from
  spoken claims.
- Consider post-finalize hook inputs only after the local hook design is
  separately approved.

## 12. Tests and Manual Verification

Automated coverage:

- Context JSONL append/read, malformed-line tolerance, clear, and session-to-
  output transfer.
- Prompt construction: context is bounded, labeled as external context, and
  absent when none is attached.
- Path and private-directory permission behavior.
- Local provider command argument construction, timeout, cancellation, queue
  capacity, and unload behavior using fixture executables.
- Cloud-configured `opencode` never receives context; the index path either
  verifies a local provider or omits context with a diagnostic.
- Scheduling: visual work waits under pressure and while heavy final passes run;
  live capture-related work never waits on it.
- Finalization rejects new context attachment (gating uses the live
  `active-recording.lock`, including the finalizer-owned `paused` case), and
  stale `context-tmp/` images are swept after simulated unclean shutdown.
- Swift pure seams for context normalization, application denylist matching, and
  screenshot resize calculations.

Manual gates:

1. Grant only Accessibility: capture a native text window, review it, ask a
   context-aware question, and confirm no Screen Recording prompt appears.
2. Revoke Accessibility, then request OCR: verify Screen Recording guidance,
   local OCR output, and temporary-image deletion. Also verify that a plain
   `meet context capture` asks for confirmation before this fallback.
3. Capture a diagram with `--visual`: verify a local model is used, no network
   request occurs, and no image remains after completion.
4. Run a recording with live Whisper, then queue VLM analysis: verify audio
   capture and live transcription continue without interruption.
5. Start medium final retranscription and diarization, then request visual
   analysis: verify it waits and later runs or reports a bounded timeout.
6. Focus a denylisted application: verify no capture occurs and no sensitive
   content is printed or persisted.
7. Finalize a meeting with accepted context: verify `context.md` moves to the
   output directory and can inform Ask AI/index generation.

## 13. Risks and Open Decisions

- **Provider choice:** MLX, llama.cpp, and loopback-only Ollama are viable.
  Choose one first based on installation and model-management ergonomics; do
  not abstract multiple providers before a real second backend is needed.
- **Focused-window capture API:** confirm the smallest ScreenCaptureKit path
  that captures only the selected window rather than the display. Prefer the
  one-shot `SCScreenshotManager.captureImage(contentFilter:)` path on macOS 14+.
- **Accessibility coverage:** many Electron/browser/canvas applications expose
  incomplete text, so OCR fallback is necessary but should stay opt-in where it
  triggers new permission.
- **Prompt contamination:** attached context may be stale, unrelated, or
  adversarial text. Prompts must label it as untrusted reference material and
  distinguish it from the meeting transcript.
- **Context size:** bound each item and the combined request size; preserve a
  short metadata record when truncating rather than silently injecting an
  unbounded document into an LLM.
- **M2 Pro resource contention:** measurements on the actual machine must set
  final model-size and queue defaults. The stated timings are estimates, not
  acceptance thresholds.
- **Retention:** text itself may be sensitive even without images. A future
  per-item deletion command and retention policy may be needed before broad use.
- **Accessibility trust and signing:** the Phase 2 helper needs Accessibility
  TCC trust, and ad-hoc signed binaries lose that grant on every rebuild.
  Follow `SPEC_TCC_SIGNING_2026-07-31.md` and document the developer-loop
  implication (re-grant after rebuild) before Phase 2 lands.
