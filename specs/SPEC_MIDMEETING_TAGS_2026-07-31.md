# SPEC: Add Tags Any Time During a Recording

**Date:** 2026-07-31
**Status:** Draft
**Owner:** Dmitrii Diakonov

---

## 1. Overview

Today tags only happen at **stop** time, and only interactively: `Recorder.promptTags()` (`src/recorder.ts:271-297`) runs `runTagPicker()` — a raw-stdin TTY menu — but only `if (!this.opts.headless && process.stdin.isTTY)`. The menu bar app always spawns `meet start ... --headless` (`RecordingController.swift:47`), so **menu-bar recordings never get tags at all** — `promptTags()` short-circuits to `tags = []` and `writeMetaFile()` bakes an empty `Tags:` line into `meta.md`.

Goal: let the user attach tags **at any point during a running recording** (not just at stop), from the menu bar app, without touching the CLI's existing interactive picker.

### Non-goals
- No change to the existing stop-time TTY picker's UX (still used by `meet start` from a terminal).
- No tag *removal* mid-meeting (add-only; the terminal picker at stop time remains the place to curate).
- No new persistent daemon/socket — stays on the file-based IPC pattern already used everywhere else in this repo (see CLAUDE.md "File-Based Communication").

---

## 2. Design

### 2.1 Decision: file inbox + existing 5s poll, not a new signal

Signals (`SIGUSR1`/`SIGUSR2`/`SIGWINCH`) carry no payload, and tag text is arbitrary. The recorder process already owns `session.json` as sole writer and already polls every 5s (`startStatus()`'s `setInterval`, `src/recorder.ts:440`). So: a one-shot CLI command drops tags into a small per-session inbox file; the recorder's existing 5s tick drains it. No new writer ever touches `session.json` but the recorder itself — same invariant as today.

```
Meet.app "Add Tag…" → NSAlert text input
  → spawn: meet tag <sessionDir> <tag1> [tag2 ...]   (one-shot, exits immediately)
       → appends each tag as a line to <sessionDir>/pending-tags.log
         (one O_APPEND appendFile per call — no read-modify-write, so concurrent
          writers can never clobber each other; dedup deferred to the drain)

Recorder (already running, headless or interactive)
  → existing 5s status tick also checks pending-tags.log
       → merges into session.tags (case-insensitive dedup), unlinks the file
       → writeAtomic(session.json)
       → new tags also appended to tags.md via existing appendTagToFile()
```

This mirrors the `finalize <sessionDir>` CLI precedent (`cli.ts:76-86`, `RecordingController` already shells out to `meet finalize` conceptually via the background finalizer) — a short-lived `meet` subcommand operating on a session directory it doesn't own.

### 2.2 Bug this also fixes

`promptTags()` currently does `this.session.tags = tags` — an **overwrite**, not a merge. Once mid-meeting tags exist in `session.tags`, the stop-time path (picker or headless no-op) must merge with them instead of clobbering. Fixed as part of this change (§3.3).

---

## 3. Implementation

### 3.1 `src/tags.ts` — pending-tags inbox

Export the existing private dedup helper and add a small queue writer/reader:

```ts
// was: function hasTagCaseInsensitive(...)
export function hasTagCaseInsensitive(arr: string[], tag: string): boolean { ... }

function pendingTagsPath(sessionDir: string): string {
  return resolve(sessionDir, "pending-tags.log");
}

// Append-only inbox: each `meet tag` appends its lines in one O_APPEND write,
// so concurrent writers can never clobber each other's tags (no read-modify-write).
// Dedup is deferred to drainPendingTags().
export async function queuePendingTags(sessionDir: string, tags: string[]): Promise<void> {
  const lines = tags.map((t) => `${t.trim()}\n`).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return;
  await appendFile(pendingTagsPath(sessionDir), lines.join(""), "utf-8");
}

// Drains and deletes the inbox; returns [] if nothing pending.
export function drainPendingTags(sessionDir: string): string[] {
  const path = pendingTagsPath(sessionDir);
  if (!existsSync(path)) return [];
  let lines: string[] = [];
  try { lines = readFileSync(path, "utf-8").split("\n"); } catch {}
  try { unlinkSync(path); } catch {}
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const line of lines) {
    const tag = line.trim();
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags;
}
```
`appendFile` (default flag `a`) creates the inbox on first write, so no exists-check race at open time. `unlinkSync`/`existsSync` join the existing `node:fs` import.

`// ponytail:` the remaining read-then-unlink window is a writer opening the file in the same instant the drainer reads-and-unlinks — a single-user local tool polling every 5s; the original writer-writer race is gone (O_APPEND), and the drain-write window only drops a tag that the next click re-adds. Upgrade to a lockfile if it ever matters.

### 3.2 `src/cli.ts` — `meet tag` subcommand

Next to `finalize` (`cli.ts:76-86`):

```ts
program
  .command("tag")
  .description("Queue tags to be picked up by a running recording session")
  .argument("<sessionDir>", "Session directory path")
  .argument("<tags...>", "One or more tags")
  .action(async (sessionDir: string, tags: string[]) => {
    await queuePendingTags(sessionDir, tags);
  });
```
Import `queuePendingTags` from `./tags.js`.

### 3.3 `src/recorder.ts` — drain on the existing 5s tick + fix the overwrite

In `startStatus()`'s interval body (`recorder.ts:440-489`), before/after the existing status line write, add:
```ts
this.applyPendingTags();
```
New private method:
```ts
private applyPendingTags(): void {
  const incoming = drainPendingTags(this.session.sessionDir);
  if (incoming.length === 0) return;
  this.session.tags = this.session.tags ?? [];
  const added: string[] = [];
  for (const tag of incoming) {
    if (!hasTagCaseInsensitive(this.session.tags, tag)) {
      this.session.tags.push(tag);
      added.push(tag);
      void appendTagToFile(tag); // best-effort: surface it in the picker's tags.md too
    }
  }
  if (added.length === 0) return;
  void writeAtomic(
    join(this.session.sessionDir, "session.json"),
    JSON.stringify(this.session, null, 2),
  ).then(() => {
    process.stdout.write(`\n${chalk.green(`Tag added: ${added.join(", ")}`)}\n`);
  });
}
```
(`writeAtomic` fire-and-forget is consistent with `togglePause()`'s pattern elsewhere in this file, except that one awaits — either is fine since it's the same session.json write path and status ticks are 5s apart, no concurrent writers.)

Fix `promptTags()` (`recorder.ts:271-297`) to merge instead of overwrite:
```ts
private async promptTags(): Promise<void> {
  this.applyPendingTags(); // catch anything queued in the last <5s before stop
  const existing = this.session.tags ?? [];
  let picked: string[] = [];
  if (!this.opts.headless && process.stdin.isTTY) {
    try {
      picked = await runTagPicker(this.session, { note: "Final transcription running in background…" });
    } catch {
      process.stdout.write(chalk.gray("(tag picker skipped)\n"));
    }
  }

  const finalTags = [...existing];
  for (const tag of picked) {
    if (!hasTagCaseInsensitive(finalTags, tag)) finalTags.push(tag);
  }

  if (finalTags.length > 0) {
    this.session.tags = finalTags;
    await writeAtomic(
      join(this.session.sessionDir, "session.json"),
      JSON.stringify(this.session, null, 2),
    );
    console.log(chalk.green(`Tags: ${finalTags.join(", ")}`));
  } else if (!this.opts.headless && process.stdin.isTTY) {
    console.log(chalk.gray("(no tags added)"));
  }

  await writeMetaFile(this.session, finalTags);
}
```
New imports in `recorder.ts`: `drainPendingTags`, `hasTagCaseInsensitive` from `./tags.js`.

Optional nicety (skip unless wanted): pre-seed `runTagPicker`'s `selectedTags` with `existing` so mid-meeting tags show as already-checked in the stop-time picker instead of just being silently merged in afterward. Not required for correctness — `finalTags` merge already keeps them. Add only if the picker screen looking tag-less-then-they-reappear is confusing in practice.

### 3.4 Menu bar app — `native/MenuBar/Sources/MeetMenuBar/`

**`RecordingController.swift`** — add alongside `pause()`/`resume()`/`extend()` (`:76-100`):
```swift
func addTag(_ raw: String) {
    guard state == .recording || state == .paused else { return }
    guard let runner = resolver.resolve(), let sessionDir = currentSessionDir() else { return }
    let tags = raw.split(separator: ",")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
    guard !tags.isEmpty else { return }

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: runner.executable)
    proc.arguments = runner.args + ["tag", sessionDir] + tags
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    try? proc.run()
}

private func currentSessionDir() -> String? {
    let lockPath = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".meet/sessions/active-recording.lock")
    guard let data = FileManager.default.contents(atPath: lockPath.path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let sessionDir = json["sessionDir"] as? String else { return nil }
    return sessionDir
}
```
Re-reads the lock file each call rather than caching `sessionDir` at start — it's already the source of truth `attachToExistingSession()` (`:102-123`) uses, so a menu-bar-attached-to-a-CLI-started session works too, for free.

**`AppDelegate.swift`** — one new menu item per active state (`:63-83`), plus the action:
```swift
// in .recording and .paused branches, after "Stop":
menu.addItem(NSMenuItem(title: "Add Tag…", action: #selector(addTag), keyEquivalent: "t"))
```
```swift
@objc func addTag() {
    guard let raw = promptTag(), !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return }
    recordingController.addTag(raw)
}

private func promptTag() -> String? {
    let alert = NSAlert()
    alert.messageText = "Add tag"
    alert.informativeText = "Tag name (comma-separated for multiple)"
    let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
    alert.accessoryView = input
    alert.addButton(withTitle: "Add")
    alert.addButton(withTitle: "Cancel")
    alert.window.initialFirstResponder = input
    return alert.runModal() == .alertFirstButtonReturn ? input.stringValue : nil
}
```
Mirrors `promptTitle()` (`AppDelegate.swift:185-196`) exactly — same modal shape, same pattern already proven in this file.

No new Swift files, no new dependency, no change to `RunnerResolver`/`Package.swift`.

---

## 4. Files touched

| File | Change |
|---|---|
| `src/tags.ts` | export `hasTagCaseInsensitive`; add `queuePendingTags()`, `drainPendingTags()` |
| `src/cli.ts` | new `meet tag <sessionDir> <tags...>` command |
| `src/recorder.ts` | `applyPendingTags()` on the existing 5s tick; fix `promptTags()` to merge, not overwrite |
| `native/MenuBar/Sources/MeetMenuBar/RecordingController.swift` | `addTag()`, `currentSessionDir()` |
| `native/MenuBar/Sources/MeetMenuBar/AppDelegate.swift` | "Add Tag…" menu item (recording/paused only) + `addTag()`/`promptTag()` |

No changes to `runTagPicker()`, `writeMetaFile()`, `types.ts`, pipeline, finalize, or diarization.

---

## 5. Testing

| Layer | Approach |
|---|---|
| `queuePendingTags` / `drainPendingTags` | Unit test in `src/tags.test.ts` (new cases): dedup case-insensitive, concurrent `queuePendingTags` calls lose no tags, drain-then-empty-file returns `[]` |
| `promptTags` merge fix | Manual — no existing `recorder.test.ts` to extend (recorder has no unit coverage today; stays that way) |
| End-to-end (menu bar) | Start recording from `Meet.app` → "Add Tag…" mid-meeting → `cat <sessionDir>/session.json` shows the tag within 5s → Stop → `meta.md` `Tags:` line includes it |
| End-to-end (CLI) | `meet start "x"` in a terminal, from another shell run `meet tag <sessionDir> foo`, confirm it shows up in the stop-time picker as pre-selected/merged and lands in `meta.md` |
| Regression | Existing terminal-only flow (no mid-meeting tags queued) behaves identically — `finalTags` merge with an empty `existing` array is the old behavior |

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Writer-writer race: two concurrent `meet tag` calls silently drop tags | Fixed in this change — append-only O_APPEND lines, dedup deferred to the drain (`§3.1`) |
| Read-then-unlink race on `pending-tags.log` if `meet tag` runs at the exact instant of a drain | `ponytail:` noted in §3.1; single-user local tool, 5s poll — a lost tag just gets re-added on next click |
| Menu bar spawns a `meet tag` process per click | One-shot, `stdio: nullDevice`, exits immediately — same cost profile as the existing background finalizer spawn |
| User adds a tag right as the meeting is stopped (race between the 5s tick and `promptTags()`) | `promptTags()` calls `applyPendingTags()` itself first (§3.3), closing the gap down to the write-to-disk latency of `meet tag`, not the 5s tick |
