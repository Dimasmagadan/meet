import Cocoa
import SwiftUI

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let recordingController = RecordingController()
    let sessionMonitor = SessionMonitor()
    let permission = PermissionController()
    let loginItem = LoginItemController()

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
            }
        }
        recordingController.onStartFailed = { [weak self] message in
            DispatchQueue.main.async {
                self?.showAlert(title: "Cannot start recording", message: message)
            }
        }

        sessionMonitor.onRecordingDetected = { [weak self] sessionDir in
            DispatchQueue.main.async {
                self?.recordingController.attachToExistingSession(sessionDir: sessionDir)
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
            menu.addItem(NSMenuItem(title: "Open Meetings Folder", action: #selector(openMeetings), keyEquivalent: "o"))

        case .recording:
            statusItem.button?.image = NSImage(systemSymbolName: "mic.circle.fill", accessibilityDescription: "Recording")
            let elapsed = recordingController.elapsedString()
            menu.addItem(NSMenuItem(title: "Recording \(elapsed)", action: nil, keyEquivalent: ""))
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Pause", action: #selector(pauseRecording), keyEquivalent: "p"))
            menu.addItem(NSMenuItem(title: "Stop", action: #selector(stopRecording), keyEquivalent: "s"))
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
            menu.addItem(NSMenuItem.separator())
            menu.addItem(NSMenuItem(title: "Open Meetings Folder", action: #selector(openMeetings), keyEquivalent: "o"))
        }

        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q"))

        statusItem.menu = menu
    }

    private func addLoginItem(to menu: NSMenu) {
        let item = NSMenuItem(title: "Launch at Login", action: #selector(toggleLogin), keyEquivalent: "")
        item.target = self
        item.state = loginItem.isEnabled ? .on : .off
        menu.addItem(item)
    }

    @objc func startRecording() {
        let defaultTitle = lastTitle() ?? "meeting"
        guard let title = promptTitle(default: defaultTitle) else { return }
        let resolved = title.isEmpty ? "meeting" : title
        saveLastTitle(resolved)

        // TCC preflight (SPEC §5). Mic is gated synchronously and refuses on deny;
        // screen is best-effort (its prompt can't be read back), then we spawn.
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
            _ = self.permission.ensureScreen()
            self.recordingController.start(title: resolved)
        }
    }

    @objc func pauseRecording() {
        recordingController.pause()
    }

    @objc func resumeRecording() {
        recordingController.resume()
    }

    @objc func stopRecording() {
        recordingController.stop()
    }

    @objc func extendRecording() {
        recordingController.extend()
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
        alert.runModal()
    }

    private func promptTitle(default defaultTitle: String) -> String? {
        let alert = NSAlert()
        alert.messageText = "Start recording"
        alert.informativeText = "Meeting title"
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        input.stringValue = defaultTitle
        alert.accessoryView = input
        alert.addButton(withTitle: "Start")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = input
        return alert.runModal() == .alertFirstButtonReturn ? input.stringValue : nil
    }

    private func lastTitle() -> String? {
        UserDefaults.standard.string(forKey: lastTitleKey)
    }

    private func saveLastTitle(_ title: String) {
        UserDefaults.standard.set(title, forKey: lastTitleKey)
    }
}
