import Cocoa
import Foundation

class RecordingController {
    enum RecordingState {
        case idle
        case recording
        case paused
    }

    var onStateChange: ((RecordingState) -> Void)?

    private var process: Process?
    private var attachedPid: pid_t?
    private var state: RecordingState = .idle {
        didSet { onStateChange?(state) }
    }
    private var startedAt: Date?
    private var timer: Timer?
    private var sessionMonitorTimer: Timer?

    private var meetBin: String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return "\(home)/www/repos/meet/dist/main.js"
    }

    func start() {
        guard state == .idle else { return }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/local/bin/node")
        proc.arguments = [meetBin, "start", "meeting", "--headless"]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
        } catch {
            print("Failed to start meet: \(error)")
            return
        }

        process = proc
        attachedPid = proc.processIdentifier
        startedAt = Date()
        state = .recording

        startTimer()
        startSessionMonitor()

        proc.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                self?.handleTermination()
            }
        }
    }

    func pause() {
        guard state == .recording, let pid = attachedPid else { return }
        sendSignal(SIGUSR1, to: pid)
        state = .paused
    }

    func resume() {
        guard state == .paused, let pid = attachedPid else { return }
        sendSignal(SIGUSR2, to: pid)
        state = .recording
    }

    func stop() {
        guard let proc = process, proc.isRunning else { return }
        sendSignal(SIGINT, to: proc.processIdentifier)
    }

    func extend() {
        guard let pid = attachedPid else { return }
        sendSignal(30, to: pid) // SIGUSR3
    }

    func attachToExistingSession(sessionDir: String) {
        guard state == .idle else { return }
        let lockPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".meet/sessions/active-recording.lock")

        guard let data = FileManager.default.contents(atPath: lockPath.path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = json["pid"] as? Int32,
              isPidAlive(pid) else { return }

        attachedPid = pid

        if let startedStr = json["startedAt"] as? String {
            let formatter = ISO8601DateFormatter()
            startedAt = formatter.date(from: startedStr)
        }

        state = .recording
        startTimer()
        startSessionMonitor()
    }

    func elapsedString() -> String {
        guard let started = startedAt else { return "00:00" }
        let elapsed = Int(Date().timeIntervalSince(started))
        let m = String(elapsed / 60).padding(toLength: 2, withPad: "0", startingAt: 0)
        let s = String(elapsed % 60).padding(toLength: 2, withPad: "0", startingAt: 0)
        return "\(m):\(s)"
    }

    func quit() {
        stop()
        stopTimer()
        stopSessionMonitor()
    }

    // MARK: - Private

    private func sendSignal(_ signal: Int32, to pid: pid_t) {
        kill(pid, signal)
    }

    private func isPidAlive(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0
    }

    private func handleTermination() {
        stopTimer()
        stopSessionMonitor()
        process = nil
        attachedPid = nil
        startedAt = nil
        state = .idle
    }

    private func startTimer() {
        stopTimer()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.onStateChange?(self?.state ?? .idle)
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func startSessionMonitor() {
        stopSessionMonitor()
        sessionMonitorTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.checkSessionState()
        }
    }

    private func stopSessionMonitor() {
        sessionMonitorTimer?.invalidate()
        sessionMonitorTimer = nil
    }

    private func checkSessionState() {
        let lockPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".meet/sessions/active-recording.lock")

        if !FileManager.default.fileExists(atPath: lockPath.path) {
            if state != .idle {
                handleTermination()
            }
        }
    }
}
