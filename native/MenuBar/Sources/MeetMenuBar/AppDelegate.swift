import Cocoa
import SwiftUI

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let recordingController = RecordingController()
    let sessionMonitor = SessionMonitor()
    let permission = PermissionController()
    let loginItem = LoginItemController()
    let notchPanelController = NotchPanelController()
    let settingsWindowController = SettingsWindowController()
    lazy var calendarAutoStart = CalendarAutoStartController(recordingController: recordingController, permission: permission)

    private let lastTitleKey = "MeetMenuBar.lastTitle"

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "mic.circle", accessibilityDescription: "Meet")
            button.imagePosition = .imageLeft
        }

        recordingController.onStateChange = { [weak self] state in
            DispatchQueue.main.async {
                self?.updateStatusItem(state: state)
                self?.notchPanelController.setArmed(state == .recording || state == .paused)
            }
        }
        notchPanelController.onAsk = { [weak self] question in
            self?.recordingController.ask(question: question) ?? false
        }
        recordingController.onStartFailed = { [weak self] message in
            DispatchQueue.main.async {
                self?.showAlert(title: "Cannot start recording", message: message)
            }
        }
        recordingController.onCaptureFailed = { [weak self] in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.showAlert(
                    title: "Recording failed to start",
                    message: "Meet could not capture system audio. Grant Meet \"System Audio Recording Only\" access in System Settings → Privacy & Security, then try again."
                )
                openPrivacySettings(.screenCapture)
            }
        }

        sessionMonitor.onRecordingDetected = { [weak self] sessionDir in
            DispatchQueue.main.async {
                self?.recordingController.attachToExistingSession(sessionDir: sessionDir)
            }
        }

        calendarAutoStart.onCalendarPermissionDenied = { [weak self] in
            DispatchQueue.main.async {
                self?.showAlert(
                    title: "Calendar access denied",
                    message: "Meet needs Calendar access to auto-record scheduled calls. Grant it in System Settings → Privacy & Security → Calendars, then re-enable \"Auto-Record Calendar Calls\"."
                )
                self?.rebuildMenu()
            }
        }
        calendarAutoStart.onMicPermissionDenied = { [weak self] in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.showAlert(
                    title: "Microphone access required",
                    message: "Meet needs microphone access to auto-record calendar calls. Grant it in System Settings → Privacy & Security → Microphone — auto-start will work once granted."
                )
                openPrivacySettings(.microphone)
            }
        }
        calendarAutoStart.onNextEventChanged = { [weak self] in
            DispatchQueue.main.async {
                guard let self = self, self.recordingController.currentDisplayState() == .idle else { return }
                self.rebuildMenu()
            }
        }

        sessionMonitor.start()
        updateStatusItem(state: .idle)
    }

    func updateStatusItem(state: RecordingController.RecordingState) {
        let menu = NSMenu()

        switch state {
        case .idle:
            statusItem.button?.image = NSImage(systemSymbolName: "mic.circle", accessibilityDescription: "Meet")
            menu.addItem(NSMenuItem(title: "Start Recording", action: #selector(startRecording), keyEquivalent: "r"))
            menu.addItem(NSMenuItem.separator())
            addLoginItem(to: menu)
            addCalendarAutoStart(to: menu)
            menu.addItem(NSMenuItem(title: "Open Meetings Folder", action: #selector(openMeetings), keyEquivalent: "o"))

        case .recording:
            statusItem.button?.image = NSImage(systemSymbolName: "mic.circle.fill", accessibilityDescription: "Recording")
            let elapsed = recordingController.elapsedString()
            menu.addItem(NSMenuItem(title: "Recording \(elapsed)", action: nil, keyEquivalent: ""))
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Pause", action: #selector(pauseRecording), keyEquivalent: "p"))
            menu.addItem(NSMenuItem(title: "Stop", action: #selector(stopRecording), keyEquivalent: "s"))
            menu.addItem(NSMenuItem(title: "Add Tag…", action: #selector(addTag), keyEquivalent: "t"))
            menu.addItem(NSMenuItem(title: "Rename Meeting…", action: #selector(renameMeeting), keyEquivalent: ""))
            menu.addItem(NSMenuItem(title: "Extend +15m", action: #selector(extendRecording), keyEquivalent: "e"))
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Open Meetings Folder", action: #selector(openMeetings), keyEquivalent: "o"))

        case .paused:
            statusItem.button?.image = NSImage(systemSymbolName: "mic.circle.fill", accessibilityDescription: "Paused")
            let elapsed = recordingController.elapsedString()
            menu.addItem(NSMenuItem(title: "Paused \(elapsed)", action: nil, keyEquivalent: ""))
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Resume", action: #selector(resumeRecording), keyEquivalent: "r"))
            menu.addItem(NSMenuItem(title: "Stop", action: #selector(stopRecording), keyEquivalent: "s"))
            menu.addItem(NSMenuItem(title: "Add Tag…", action: #selector(addTag), keyEquivalent: "t"))
            menu.addItem(NSMenuItem(title: "Rename Meeting…", action: #selector(renameMeeting), keyEquivalent: ""))
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Open Meetings Folder", action: #selector(openMeetings), keyEquivalent: "o"))
        }

        menu.addItem(NSMenuItem.separator())
        let settingsItem = NSMenuItem(title: "Settings…", action: #selector(openSettings), keyEquivalent: ",")
        settingsItem.target = self
        menu.addItem(settingsItem)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q"))

        statusItem.menu = menu
    }

    private func addLoginItem(to menu: NSMenu) {
        let item = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
        item.target = self
        item.state = loginItem.isEnabled ? .on : .off
        menu.addItem(item)
    }

    // SPEC_CALENDAR_AUTOSTART_2026-08-04 §2.8 — checkable toggle plus a disabled "Next: …"
    // line so a silent, confirmation-free feature stays observable from the menu alone.
    private func addCalendarAutoStart(to menu: NSMenu) {
        let item = NSMenuItem(title: "Auto-Record Calendar Calls", action: #selector(toggleCalendarAutoStart), keyEquivalent: "")
        item.target = self
        item.state = calendarAutoStart.isEnabled ? .on : .off
        menu.addItem(item)

        if let summary = calendarAutoStart.nextEventSummary() {
            let nextItem = NSMenuItem(title: "Next: \(summary)", action: nil, keyEquivalent: "")
            nextItem.isEnabled = false
            menu.addItem(nextItem)
        }
    }

    // Silent start (SPEC_SILENT_START_TAG_WINDOW_RENAME_2026-08-25): recording begins under
    // the default title "meeting" the instant the mic gate clears and nothing follows it —
    // no naming popup, no dialog of any kind. Naming happens afterwards via "Rename Meeting…"
    // or the title field in either tag window (Add Tag… / Stop).
    @objc func startRecording() {
        // TCC preflight. Mic is gated synchronously and refuses on deny. System audio has no
        // public preflight API (Core Audio process taps, SPEC_TCC_SCREEN_REPROMPT_2026-07-31
        // §6) — AudioCapture raises the real "System Audio Recording Only" prompt itself, and
        // capture failures are surfaced post-spawn via RecordingController.onCaptureFailed.
        // @MainActor: startRecording() is a plain @objc action — dynamically on the
        // main thread, but with no *static* isolation, so a bare Task{} resumes off-main
        // after the await. Pin to the main actor so NSAlert.runModal() stays on-main and
        // RecordingController.start() schedules its Timers on the main RunLoop (which
        // AppKit pumps); a pool thread's RunLoop is never run, freezing elapsed + monitor.
        Task { @MainActor in
            let micOk = await permission.ensureMic()
            guard micOk else {
                self.showAlert(
                    title: "Microphone access required",
                    message: "Meet needs microphone access to record. Grant it in System Settings → Privacy & Security → Microphone."
                )
                openPrivacySettings(.microphone)
                return
            }
            self.recordingController.start(title: "meeting")
        }
    }

    @objc func renameMeeting() {
        let defaultTitle = lastTitle() ?? "meeting"
        guard let title = promptText(message: "Rename Meeting", info: "New meeting title", ok: "Rename", default: defaultTitle) else { return }
        submitRetitle(title)
    }

    @objc func pauseRecording() {
        recordingController.pause()
    }

    @objc func resumeRecording() {
        recordingController.resume()
    }

    @objc func stopRecording() {
        let current = recordingController.fetchTagsState()
        let originalTitle = recordingController.fetchCurrentTitle()
        guard let (tags, newTitle) = promptTags(message: "Stop recording", info: "Tags (optional)", ok: "Stop", preChecked: current, defaultTitle: originalTitle) else { return }
        applyTagWindowRename(original: originalTitle, submitted: newTitle)
        if !recordingController.setTags(tags) {
            showAlert(title: "Tags not saved", message: "Meet could not save tags for this recording. Stopping anyway.")
        }
        recordingController.stop()
    }

    @objc func extendRecording() {
        recordingController.extend()
    }

    @objc func addTag() {
        let current = recordingController.fetchTagsState()
        let originalTitle = recordingController.fetchCurrentTitle()
        guard let (tags, newTitle) = promptTags(message: "Add tag", info: "Select tags or type a new one", ok: "Add", preChecked: current, defaultTitle: originalTitle) else { return }
        applyTagWindowRename(original: originalTitle, submitted: newTitle)
        if !recordingController.setTags(tags) {
            showAlert(title: "Tags not saved", message: "Meet could not save tags for this recording.")
        }
    }

    @objc func toggleLogin() {
        do {
            if loginItem.isEnabled {
                try loginItem.disable()
            } else {
                try loginItem.enable()
            }
        } catch {
            showAlert(
                title: "Cannot change login item",
                message: "Open System Settings → General → Login Items to manage Meet manually. (\(error.localizedDescription))"
            )
        }
        rebuildMenu()
    }

    @objc func toggleCalendarAutoStart() {
        calendarAutoStart.setEnabled(!calendarAutoStart.isEnabled)
        rebuildMenu()
    }

    @objc func openSettings() {
        settingsWindowController.show()
    }

    @objc func openMeetings() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let meetingsDir = "\(home)/Meetings"
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: meetingsDir)
    }

    @objc func quitApp() {
        recordingController.quit()
        NSApplication.shared.terminate(nil)
    }

    // MARK: - Private

    private func rebuildMenu() {
        updateStatusItem(state: recordingController.currentDisplayState())
    }

    private func showAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        // The app may have just been bounced back to .accessory by a preceding prompt's
        // policy restore, which makes macOS hand activation to another app; this alert can
        // then surface behind its window. Force frontmost so it's always seen.
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // The app runs as .accessory (Dock-less). A Dock-less app is never the "true"
    // frontmost app from the input-method system, so the keyboard layout shortcut
    // (Ctrl+Space / Caps Lock / fn) doesn't switch inside the field — it stays pinned to
    // whatever was last active. Become a regular app for the duration of the modal, then
    // restore. Order matters: .regular first so activate() lifts us as a real frontmost
    // app, not an accessory one (which is what caused the flaky layout switching).
    // defer covers any future guard/return between runModal and the restore so the Dock
    // icon never gets stranded.
    private func runModalAsRegularApp(_ alert: NSAlert) -> NSApplication.ModalResponse {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        defer { NSApp.setActivationPolicy(.accessory) }
        return alert.runModal()
    }

    private func promptText(message: String, info: String, ok: String, default def: String = "") -> String? {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = info
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        input.stringValue = def
        alert.accessoryView = input
        alert.addButton(withTitle: ok)
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = input
        // Queued, not called directly: fires once the modal run loop is already pumping
        // (after NSAlert's own show/layout), so it doesn't fight that layout pass the way
        // calling makeKeyAndOrderFront/makeFirstResponder before runModal() did.
        DispatchQueue.main.async { alert.window.makeFirstResponder(input) }
        let result = runModalAsRegularApp(alert)
        guard result == .alertFirstButtonReturn else { return nil }
        return input.stringValue
    }

    // Checkbox per tag in tags.md + a free-text field for a brand-new one, plus a meeting
    // title field on top (SPEC_SILENT_START_TAG_WINDOW_RENAME_2026-08-25) prefilled with the
    // live title. Returns the full checked selection (+ any newly typed tag) and the
    // submitted title — both call sites pass the tags straight to recordingController.setTags(),
    // which replaces the session's tag state wholesale; [] means nothing selected, not
    // cancelled. nil means cancelled.
    private func promptTags(message: String, info: String, ok: String, preChecked: [String] = [], defaultTitle: String) -> (tags: [String], title: String)? {
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = info

        let existingTags = recordingController.fetchAvailableTags()
        let checkboxes: [NSButton] = existingTags.map { tag in
            let checkbox = NSButton(checkboxWithTitle: tag, target: nil, action: nil)
            if preChecked.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) { checkbox.state = .on }
            return checkbox
        }

        let titleField = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
        titleField.stringValue = defaultTitle
        titleField.placeholderString = "Meeting title"

        let newTagField = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
        newTagField.placeholderString = "New tag"

        let stack = NSStackView(views: [titleField] + checkboxes + [newTagField])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 6
        // NSAlert sizes its panel from accessoryView.frame at assignment time, not from
        // Auto Layout constraints — a widthAnchor constraint here fights the view's default
        // translatesAutoresizingMaskIntoConstraints=true and collapses everything to (0,0),
        // which is why the checkboxes overlapped and fell outside the clickable area. Compute
        // the natural size via fittingSize and set the frame directly instead.
        stack.setFrameSize(stack.fittingSize)

        alert.accessoryView = stack
        alert.addButton(withTitle: ok)
        alert.addButton(withTitle: "Cancel")
        // Focus stays on newTagField even with the title field present: picking tags is the
        // common action; renaming is secondary.
        alert.window.initialFirstResponder = newTagField
        DispatchQueue.main.async { alert.window.makeFirstResponder(newTagField) }
        let result = runModalAsRegularApp(alert)
        guard result == .alertFirstButtonReturn else { return nil }

        var selected = checkboxes.filter { $0.state == .on }.map { $0.title }
        let newTag = newTagField.stringValue.trimmingCharacters(in: .whitespaces)
        if !newTag.isEmpty { selected.append(newTag) }
        return (selected, titleField.stringValue)
    }

    // Applies a tag-window rename only when the submitted title actually differs from the
    // live one captured when the dialog opened. submitRetitle's own guard makes empty and
    // literal-"meeting" submissions no-ops, so a cleared field can't clobber anything.
    private func applyTagWindowRename(original: String, submitted: String) {
        let trimmed = submitted.trimmingCharacters(in: .whitespaces)
        guard trimmed != original else { return }
        submitRetitle(trimmed)
    }

    // Shared by "Rename Meeting…" and the tag windows' title fields — only a real
    // (non-default) title is worth a retitle spawn or remembering as lastTitle();
    // "meeting" (empty field, or literally typing the default) is already what's
    // live, so it's a no-op.
    private func submitRetitle(_ title: String) {
        let resolved = title.isEmpty ? "meeting" : title
        guard resolved != "meeting" else { return }
        saveLastTitle(resolved)
        if !recordingController.retitle(title: resolved) {
            showAlert(title: "Rename failed", message: "Meet could not rename this recording.")
        }
    }

    private func lastTitle() -> String? {
        UserDefaults.standard.string(forKey: lastTitleKey)
    }

    private func saveLastTitle(_ title: String) {
        UserDefaults.standard.set(title, forKey: lastTitleKey)
    }
}
