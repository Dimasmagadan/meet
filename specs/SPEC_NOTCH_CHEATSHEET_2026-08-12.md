# SPEC: Notch Panel — Cheat Sheet mode

**Date:** 2026-08-12
**Status:** Draft — pre-implementation
**Owner:** Dmitrii Diakonov

---

## 1. Overview

A third `Mode` for the existing notch panel (`NotchPanelController`,
`specs/SPEC_NOTCH_TRANSCRIPT_PANEL_2026-08-03.md` base,
`specs/SPEC_NOTCH_TABS_2026-08-12.md` Ask AI). A user-configured Markdown file —
written and kept up to date by some *other* tool before/during the call (call
prep notes, account context, talking points) — becomes visible as a tab next to
Транскрипт and Ask AI.

1. **Транскрипт** — unchanged.
2. **Ask AI** — unchanged.
3. **Шпаргалка** (Cheat Sheet) — renders `cheatSheetPath` (config.json) as
   Markdown, re-read on every poll tick while the panel is visible.

The mode button becomes a **3-way cycle** instead of a 2-way toggle:
Транскрипт → Ask AI → Шпаргалка → Транскрипт. Still one button, still no
`NSTabView` — three short-lived views don't justify a tab container any more
than two did.

### Non-goals
- **No file watching (FSEvents/DispatchSource).** The panel only polls while
  hovered/visible (`startPolling()` is wired from `handleHover(true)`,
  `:214-228`), same as the transcript tail. A 1s-stale read of a file the user
  isn't currently looking at is not a bug worth a new subsystem for.
- **No full CommonMark.** Confirmed with the user: inline only (bold, italic,
  `code`, links) via `AttributedString(markdown:)`. Headers/lists/tables render
  as their literal characters (`# `, `- `), not specially styled. Upgrade path
  if that turns out to matter: `.full` interpretedSyntax + walk
  `presentationIntent` for block-level styling — not this pass.
- **No per-meeting path.** One global `cheatSheetPath` in `config.json`,
  matching the user's stated workflow (an external tool always overwrites the
  same file). No per-session override, no lock-file plumbing like `attendees`.
- **No in-app editing.** Read-only `NSTextView`, same as transcript.
- **No error dialog for a missing/unreadable file.** Placeholder text in the
  panel; the failure is low-stakes and self-evident (empty cheat sheet tab).
- **No tab visibility gating.** The cheat sheet mode is always in the cycle,
  configured or not — showing a "not configured, see Settings" placeholder is
  simpler than conditionally skipping a cycle step.

---

## 2. UX

### 2.1 Cycle button
`toggleMode()` (`:265`) becomes a 3-way `switch`:
```
.transcript -> .askAI
.askAI      -> .cheatSheet
.cheatSheet -> .transcript
```
`modeButton.title` always names the mode you're about to switch *to* (unchanged
convention): "Ask AI" in Транскрипт, **"Шпаргалка" in Ask AI (was
"Транскрипт" — this is the one behavior change to existing Ask AI UX)**,
"Транскрипт" in Шпаргалка.

### 2.2 Шпаргалка layout
Same layout family as Транскрипт, not Ask AI: `expandButton` visible (Раскрыть
toggles `expandedFrame`/`bigFrame`, same as transcript), no ask input row, no
forced `bigFrame`, no key-panel focus grab. `currentTargetFrame()` (`:237`)
already returns the toggle-based frame for any mode that isn't `.askAI`, so it
needs **no change**. `toggleBigExpand()`'s guard (`:256`,
`guard mode == .transcript else { return }`) widens to
`guard mode != .askAI else { return }` so Раскрыть keeps working here too.

### 2.3 Content states
- **Unset** (`cheatSheetPath` absent/empty in config): placeholder
  `"Шпаргалка не настроена. Settings → Cheat Sheet File."`
- **File missing/unreadable**: `"Файл не найден: <path>"`.
- **Present**: rendered Markdown, scrolled to top.

### 2.4 Refresh behavior — jump-to-top only on real change
Cheat sheet content is reference material, not a growing log — no
stick-to-bottom logic like transcript. But re-rendering (and resetting scroll
to top) on *every* 1s tick would yank the panel out from under someone mid-read
even when the file hasn't changed. `updateCheatSheet()` diffs against
`lastCheatSheetContent: String?`; identical content is a no-op (scroll position
untouched). Entering the mode always resets `lastCheatSheetContent = nil`
first, so switching to Шпаргалка always shows a fresh top-of-file render even
if the tab was visited earlier in the same call.

---

## 3. Architecture

### 3.1 Config
`cheatSheetPath: String` (absolute path) in `~/.meet/config.json`, read via
`ConfigStore.string(config, "cheatSheetPath", default: "")` (`ConfigStore.swift:37`).
Swift-only key — `ConfigStore.load()`/`save()` already round-trip unknown keys
untouched (`:3-6`), and Node's `loadConfig()` (`src/storage.ts:36-44`) just
spreads `fileConfig` over `DEFAULT_CONFIG` with no runtime key validation, so
**no `src/types.ts` / `src/storage.ts` change is needed** — this key is never
read on the Node side.

`NotchPanelController` reads it directly via `ConfigStore.load()` (a new access
pattern for this file — everything else there reads the per-session lock via
`ActiveLock`, since `cheatSheetPath` is a global setting, not session state):
```swift
static func currentCheatSheetPath() -> String? {
    let raw = ConfigStore.string(ConfigStore.load(), "cheatSheetPath", default: "")
    return resolveCheatSheetPath(raw)
}

// Pure — testable without touching disk. nil/empty -> nil; expands ~ since
// Settings' "Choose File…" panel writes an absolute path but a hand-edited
// config.json might not.
static func resolveCheatSheetPath(_ raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return nil }
    return (trimmed as NSString).expandingTildeInPath
}
```

### 3.2 Settings UI
`SettingsWindowController.swift`: one more field + a file-picker button, same
tier as `openConfigButton` (`:95`), not a checkbox-with-hint since it's a path:
```swift
private let cheatSheetPathField = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
```
Row = `labeledRow("Cheat Sheet File:", cheatSheetPathField)` + a
`"Выбрать файл…"` button wired to `NSOpenPanel` (`canChooseFiles = true`,
`canChooseDirectories = false`) that writes `url.path` into the field —
picker output is always absolute, so `resolveCheatSheetPath`'s tilde-expansion
only matters for a manually hand-edited config.
`loadIntoFields()` / `save()` follow the existing `languageField` pattern
(`:53`, `:66`); `save()` uses
`config["cheatSheetPath"] = field.stringValue.isEmpty ? nil : field.stringValue`
so an emptied field removes the key instead of storing `""`.

### 3.3 Rendering — inline Markdown → NSAttributedString
`AttributedString(markdown:)` parses inline emphasis into an
`.inlinePresentationIntent` attribute; converting straight to `NSAttributedString`
does **not** turn that into an `NSFont` trait (no native bridge for it), so a
naive `NSAttributedString(parsed)` would show all-plain text with the `**`
already stripped but no visual bold. `renderMarkdown` (pure, static — testable)
walks the parsed runs and maps intent → font trait:
```swift
static func renderMarkdown(_ text: String) -> NSAttributedString {
    let base = NSFont.systemFont(ofSize: 14)
    let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    guard let parsed = try? AttributedString(markdown: text, options: options) else {
        return NSAttributedString(string: text, attributes: [.font: base, .foregroundColor: NSColor.white])
    }
    let result = NSMutableAttributedString()
    for run in parsed.runs {
        let chunk = String(parsed[run.range].characters)
        var font = base
        let intent = run.inlinePresentationIntent ?? []
        if intent.contains(.code) {
            font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        } else {
            var traits: NSFontDescriptor.SymbolicTraits = []
            if intent.contains(.stronglyEmphasized) { traits.insert(.bold) }
            if intent.contains(.emphasized) { traits.insert(.italic) }
            if !traits.isEmpty, let d = base.fontDescriptor.withSymbolicTraits(traits) as NSFontDescriptor? {
                font = NSFont(descriptor: d, size: 14) ?? base
            }
        }
        result.append(NSAttributedString(string: chunk, attributes: [.font: font, .foregroundColor: NSColor.white]))
    }
    return result
}
```
Links (`intent` doesn't cover those — separate `.link` attribute in
`AttributedString`) get the same base font, underline optional; not worth a
special case for a first pass.

### 3.4 Update path
```swift
private func updateCheatSheet() {
    guard let textView = textView else { return }
    guard let path = Self.currentCheatSheetPath() else {
        renderCheatSheetPlaceholder(Self.cheatSheetUnsetPlaceholder); return
    }
    guard let content = try? String(contentsOfFile: path, encoding: .utf8) else {
        renderCheatSheetPlaceholder("Файл не найден: \(path)"); return
    }
    guard content != lastCheatSheetContent else { return }
    lastCheatSheetContent = content
    textView.textStorage?.setAttributedString(Self.renderMarkdown(content))
    textView.scrollToBeginningOfDocument(nil)
}
```
Wired into `pollTick()`'s `switch` (`:393`) as a third case, and `setMode(.cheatSheet)`
resets `lastCheatSheetContent = nil` before calling it (§2.4). `disarm()` (`:100-109`)
also resets `lastCheatSheetContent = nil`, joining the existing
`askInFlight`/`pendingAskId`/`lastAnswer` resets there — the controller is a
long-lived singleton across meetings, so stale cross-meeting cache is a latent
(if harmless) trap worth closing while touching this code anyway.

---

## 4. Files touched

| File | Change |
|---|---|
| `native/MenuBar/Sources/MeetMenuBar/NotchPanelController.swift` | `Mode.cheatSheet`, 3-way `toggleMode()` cycle, widened `toggleBigExpand()` guard, `updateCheatSheet()`, `renderMarkdown()`, `resolveCheatSheetPath()`, `currentCheatSheetPath()`, `lastCheatSheetContent` state, `pollTick()`/`setMode()`/`disarm()` cases |
| `native/MenuBar/Sources/MeetMenuBar/SettingsWindowController.swift` | `cheatSheetPathField` + "Выбрать файл…" button, load/save |

No `src/*.ts` changes (§3.1).

---

## 5. Testing

**Swift `--self-test-notch`** (extends `selfCheckTailExtraction`):
- `resolveCheatSheetPath`: `""` / whitespace-only → `nil`; `"~/notes.md"` →
  expands to the home directory; already-absolute path unchanged.
- `renderMarkdown("**bold** and *italic* and \`code\`")`: `.string` equals
  `"bold and italic and code"` (markers stripped); the "bold" range carries a
  bold `NSFont`, "italic" an italic `NSFont`, "code" a monospaced `NSFont` —
  assert via `attribute(.font, at:effectiveRange:)`.
- 3-way `toggleMode()` cycle: from each of the three modes, one call lands on
  the expected next mode (pin the "Ask AI → Шпаргалка, not → Транскрипт"
  behavior change from §2.1).

**Manual** (no headless way to assert `NSPanel`/live-file state):
- Settings: "Выбрать файл…" populates the path field; Save persists it and
  round-trips on reopen; clearing the field + Save removes the key from
  `config.json` (not `""`).
- Unset path → placeholder; point at a real `.md` file → renders with bold/italic
  visible; point at a nonexistent path → "Файл не найден: …".
- Edit the file with another tool while the tab is open and hovered → next
  poll tick (≤1s) picks up the change, scrolls to top.
- Sit on the tab reading (don't touch the file) → no scroll jump on subsequent
  ticks (content unchanged).
- Cycle Транскрипт → Ask AI → Шпаргалка → Транскрипт via repeated clicks,
  confirm each view's layout (expand button visible/hidden, ask row
  visible/hidden) matches §2.2.
- Raскрыть toggles `bigFrame` from the Шпаргалка tab same as from Транскрипт.

---

## 6. Open questions / risks

- Jump-to-top on genuine content change (§2.4) vs. preserving scroll offset —
  going with jump-to-top since it's simpler and "content changed" is a
  reasonable cue to re-read from the top; revisit if it turns out to be
  annoying for long cheat sheets that get small edits mid-call.
- `AttributedString(markdown:)`'s `.inlineOnlyPreservingWhitespace` parsing
  behavior on malformed/partial Markdown (e.g. the external tool writes the
  file mid-save and the panel polls a half-written `**bold`) isn't pinned by a
  test — worst case is a glitchy render for one tick, self-corrects next poll.
- No sandboxing concern: the path comes from the user's own Settings window,
  same trust boundary as `ConfigStore.path` itself.
