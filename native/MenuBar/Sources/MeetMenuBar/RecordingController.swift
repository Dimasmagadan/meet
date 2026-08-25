import Cocoa
import Foundation

class RecordingController {
    enum RecordingState {
        case idle
        case recording
        case paused
    }

    var onStateChange: ((RecordingState) -> Void)?
    // Fires when Start cannot proceed (meet not found / spawn failed) so AppDelegate
    // can surface an NSAlert instead of silently doing nothing.
    var onStartFailed: ((String) -> Void)?
    // Fires when the spawned recording exits shortly after start without the user
    // stopping it (capture/permission failure). Distinct from onStartFailed so
    // AppDelegate can point the user at the right privacy pane (SPEC_TCC_SCREEN_REPROMPT §5.1).
    var onCaptureFailed: (() -> Void)?

    private var process: Process?
    private var attachedPid: pid_t?
    private var state: RecordingState = .idle {
        didSet { onStateChange?(state) }
    }
    private var startedAt: Date?
    private var timer: Timer?
    private var sessionMonitorTimer: Timer?
    // Capture-failure heuristics. userStopped distinguishes a user Stop from an
    // unexpected exit; spawnedAt (spawn sessions only) bounds the failure window;
    // terminationHandled makes handleTermination() fire-once across its two callers.
    private var userStopped = false
    private var spawnedAt: Date?
    private var terminationHandled = false

    private let resolver = RunnerResolver()

    // maxDurationMinutes/attendees: calendar auto-start (SPEC_CALENDAR_AUTOSTART_2026-08-04
    // §2.6/§3/§6.1). Manual Start keeps calling this with defaults, so nil/[] preserves
    // today's behavior (config.maxDurationMinutes via the CLI's own default, no --attendees).
    func start(title: String, maxDurationMinutes: Int? = nil, attendees: [String] = []) {
        guard state == .idle else { return }

        guard let runner = resolver.resolve() else {
            onStartFailed?("meet was not found. Run `meet setup` (and `npm link` if needed) so `meet bin-path` resolves.")
            return
        }

        var args = runner.args + ["start", title, "--headless"]
        if let maxDurationMinutes {
            args += ["--max-duration", "\(maxDurationMinutes)"]
        }
        if !attendees.isEmpty {
            args += ["--attendees", attendees.joined(separator: ",")]
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: runner.executable)
        proc.arguments = args
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
        } catch {
            onStartFailed?("Failed to start meet: \(error.localizedDescription)")
            return
        }

        process = proc
        attachedPid = proc.processIdentifier
        startedAt = Date()
        spawnedAt = Date()
        userStopped = false
        terminationHandled = false
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
        userStopped = true
        if let proc = process, proc.isRunning {
            sendSignal(SIGINT, to: proc.processIdentifier)
        } else if let pid = attachedPid {
            sendSignal(SIGINT, to: pid)
        }
    }

    func extend() {
        guard let pid = attachedPid else { return }
        sendSignal(SIGWINCH, to: pid)
    }

    // Replaces the session's full tag selection (never appends) — both the mid-call
    // "Add Tag…" picker and the Stop picker always submit their complete checked set,
    // so the CLI's `tag` command overwrites tags-state.json wholesale each time.
    @discardableResult
    func setTags(_ tags: [String]) -> Bool {
        guard state == .recording || state == .paused else { return false }
        guard let runner = resolver.resolve(), let sessionDir = currentSessionDir() else { return false }
        let cleaned = tags.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: runner.executable)
        proc.arguments = runner.args + ["tag", sessionDir] + cleaned
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()   // the write must land before the stop flow's SIGINT
        } catch {
            return false
        }
        return proc.terminationStatus == 0
    }

    // Mirrors setTags(): guards on live state, spawns `meet retitle` synchronously (the
    // write must land regardless of whatever happens next in the caller), waits for exit.
    // The actual folder move happens in the live Recorder process (recorder.ts:applyPendingRetitle)
    // on its next 5s status tick — this just drops the marker file.
    @discardableResult
    func retitle(title: String) -> Bool {
        guard state == .recording || state == .paused else { return false }
        guard let runner = resolver.resolve(), let sessionDir = currentSessionDir() else { return false }
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: runner.executable)
        proc.arguments = runner.args + ["retitle", sessionDir, trimmed]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return false
        }
        return proc.terminationStatus == 0
    }

    // Mirrors retitle(title:) exactly: guards on live state, resolves the runner,
    // spawns `meet ask` synchronously (the marker write must land before the panel
    // polls for the id), returns terminationStatus == 0. The actual opencode question
    // runs in the live Recorder process (recorder.ts:applyPendingAskQuestion).
    @discardableResult
    func ask(question: String) -> Bool {
        guard state == .recording || state == .paused else { return false }
        guard let runner = resolver.resolve(), let sessionDir = currentSessionDir() else { return false }
        let trimmed = question.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return false }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: runner.executable)
        proc.arguments = runner.args + ["ask", sessionDir, trimmed]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return false
        }
        return proc.terminationStatus == 0
    }

    // Synchronous `meet tags` spawn (Node cold start, same cost as setTags) — called only
    // when a tag-picker dialog is about to open, not on a hot path.
    func fetchAvailableTags() -> [String] {
        runAndCaptureLines(["tags"])
    }

    // The session's current tag selection (from tags-state.json), so any picker —
    // mid-call "Add Tag…" or Stop — can pre-check what was already selected.
    func fetchTagsState() -> [String] {
        guard let sessionDir = currentSessionDir() else { return [] }
        return runAndCaptureLines(["tags", "--session", sessionDir])
    }

    // Live session title straight from active-recording.lock — local JSON read, no spawn
    // (mirrors currentSessionDir()), safe right before opening a dialog. Fresh because
    // Recorder.applyPendingRetitle() rewrites the lock after every folder move.
    func fetchCurrentTitle() -> String {
        ActiveLock.read()?["title"] as? String ?? "meeting"
    }

    private func runAndCaptureLines(_ args: [String]) -> [String] {
        guard let runner = resolver.resolve() else { return [] }
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: runner.executable)
        proc.arguments = runner.args + args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0, let output = String(data: data, encoding: .utf8) else { return [] }
            return output.split(separator: "\n").map { String($0) }
        } catch {
            return []
        }
    }

    func attachToExistingSession(sessionDir: String) {
        guard state == .idle else { return }

        guard let json = ActiveLock.read(),
              let pid = json["pid"] as? Int32,
              isPidAlive(pid) else { return }

        attachedPid = pid
        terminationHandled = false

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
        return String(format: "%02d:%02d", elapsed / 60, elapsed % 60)
    }

    func currentDisplayState() -> RecordingState { state }

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

    private func currentSessionDir() -> String? {
        ActiveLock.read()?["sessionDir"] as? String
    }

    private func handleTermination() {
        // Called from both proc.terminationHandler and checkSessionState(); make it fire-once.
        guard !terminationHandled else { return }
        terminationHandled = true

        // A spawned session that died without the user stopping it, within a short window of
        // start, is a capture/permission failure (e.g. Screen Recording denied / stale csreq).
        // userStopped guards normal Stop; auto-stops run far past this window; attached sessions
        // have no spawnedAt. The SCK failure path (stale csreq, §3 H1) exits within seconds.
        let fastCaptureFailure: Bool = {
            guard !userStopped, let start = spawnedAt else { return false }
            return Date().timeIntervalSince(start) < 15
        }()

        stopTimer()
        stopSessionMonitor()
        process = nil
        attachedPid = nil
        startedAt = nil
        spawnedAt = nil
        state = .idle

        if fastCaptureFailure { onCaptureFailed?() }
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
        if !ActiveLock.exists() {
            if state != .idle {
                handleTermination()
            }
        }
    }
}
