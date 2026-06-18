import Cocoa
import SwiftUI

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let recordingController = RecordingController()
    let sessionMonitor = SessionMonitor()

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

    @objc func startRecording() {
        recordingController.start()
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

    @objc func openMeetings() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let meetingsDir = "\(home)/Meetings"
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: meetingsDir)
    }

    @objc func quitApp() {
        recordingController.quit()
        NSApplication.shared.terminate(nil)
    }
}
