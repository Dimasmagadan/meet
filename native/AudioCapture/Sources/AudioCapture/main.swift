import ArgumentParser
import Dispatch
import Foundation

@main
struct AudioCaptureCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "AudioCapture")

    @Option(name: .long, help: "Directory for output WAV chunks")
    var outputDir: String

    @Option(name: .long, help: "Chunk duration in seconds")
    var chunkDuration: Int = 15

    @Option(name: .long, help: "Capture mode: full (mic + system) or mic")
    var mode: String = "full"

    @Option(name: .long, help: "Stop after N seconds of silence (0 = disabled)")
    var silenceTimeout: Int = 0

    @Flag(name: .long, help: "Enable VoiceProcessing IO for mic echo cancellation")
    var voiceProcessing: Bool = false

    @Flag(name: .long, help: "In full mode, keep running if mic or system audio fails to start instead of exiting")
    var allowDegraded: Bool = false

    func run() async throws {
        let runner = CaptureRunner(outputDir: outputDir, chunkDuration: chunkDuration, mode: mode, silenceTimeout: silenceTimeout, voiceProcessing: voiceProcessing, allowDegraded: allowDegraded)
        try await runner.run()
    }
}

@available(macOS 14.0, *)
class CaptureRunner {
    let outputDir: String
    let chunkDuration: Int
    let mode: String
    let silenceTimeout: Int
    let voiceProcessing: Bool
    let allowDegraded: Bool
    var micCapture: MicCapture?
    // Typed as Any? because SystemAudioCapture requires macOS 14.2+ while CaptureRunner (used for
    // mic-only mode too) targets 14.0+; cast at each use site instead of raising this class's
    // availability floor for a feature only the "full" mode needs.
    var systemCapture: Any?
    var shouldStop = false
    // Retained for the process lifetime — a DispatchSourceSignal is cancelled/torn down
    // if it's deallocated, so these must outlive `run()`'s signal-handling loop.
    var signalSources: [DispatchSourceSignal] = []

    init(outputDir: String, chunkDuration: Int, mode: String, silenceTimeout: Int, voiceProcessing: Bool, allowDegraded: Bool) {
        self.outputDir = outputDir
        self.chunkDuration = chunkDuration
        self.mode = mode
        self.silenceTimeout = silenceTimeout
        self.voiceProcessing = voiceProcessing
        self.allowDegraded = allowDegraded
    }

    func run() async throws {
        let dir = URL(fileURLWithPath: outputDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Raw signal() handlers run in signal-handler context on an arbitrary
        // thread, where touching Swift objects (ARC retain/release, lazy
        // singleton init) is not async-signal-safe. SIG_IGN the default
        // disposition, then let a DispatchSourceSignal on a dedicated serial
        // queue deliver the notification as an ordinary closure call instead.
        let controlQueue = DispatchQueue(label: "audiocapture.signals")
        func installSignalSource(_ sig: Int32, _ handler: @escaping () -> Void) {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: controlQueue)
            source.setEventHandler(handler: handler)
            source.resume()
            signalSources.append(source)
        }
        installSignalSource(SIGINT) { CaptureRunnerSignalRelay.shared.trigger() }
        installSignalSource(SIGTERM) { CaptureRunnerSignalRelay.shared.trigger() }
        installSignalSource(SIGUSR1) { CaptureRunnerSignalRelay.shared.setPaused(true) }
        installSignalSource(SIGUSR2) { CaptureRunnerSignalRelay.shared.setPaused(false) }

        fputs("AudioCapture started: mode=\(mode) dir=\(outputDir) silence=\(silenceTimeout)s\n", stderr)
        logJSON("info", "capture_started", ["mode": mode, "dir": outputDir, "silence": silenceTimeout])

        if mode == "full" || mode == "mic" {
            let mic = MicCapture(outputDir: dir, chunkDurationSeconds: chunkDuration, voiceProcessing: voiceProcessing) { name in
                let idx = Int(name.replacingOccurrences(of: "mic-", with: "").replacingOccurrences(of: ".wav", with: "")) ?? 0
                logJSON("info", "chunk_finalized", ["source": "mic", "filename": name, "index": idx])
            }
            do {
                try mic.start()
                micCapture = mic
                fputs("Mic capture started\n", stderr)
                logJSON("info", "stream_started", ["source": "mic"])
            } catch {
                fputs("Mic capture failed: \(error)\n", stderr)
                logJSON("error", "stream_error", ["source": "mic", "message": String(describing: error)])
                // Full mode silently continuing on one failed stream can record
                // nothing (or only the other channel) with no visible signal to
                // the caller. Fail startup unless degraded mode is opted into.
                if mode == "mic" || !allowDegraded { throw error }
            }
        }

        if mode == "full" {
            if #available(macOS 14.2, *) {
                let sys = SystemAudioCapture(outputDir: dir, chunkDurationSeconds: chunkDuration) { name in
                    let idx = Int(name.replacingOccurrences(of: "sys-", with: "").replacingOccurrences(of: ".wav", with: "")) ?? 0
                    logJSON("info", "chunk_finalized", ["source": "sys", "filename": name, "index": idx])
                }
                do {
                    try sys.start()
                    systemCapture = sys
                    fputs("System audio capture started\n", stderr)
                    logJSON("info", "stream_started", ["source": "sys"])
                } catch {
                    fputs("System audio capture failed: \(error)\n", stderr)
                    logJSON("error", "stream_error", ["source": "sys", "message": String(describing: error)])
                    if !allowDegraded {
                        stopAll() // mic may already be recording; close its WAV before exiting
                        throw error
                    }
                }
            } else {
                fputs("System audio capture requires macOS 14.2+ (Core Audio process taps)\n", stderr)
                logJSON("error", "stream_error", ["source": "sys", "message": "macOS 14.2+ required"])
                if !allowDegraded {
                    stopAll()
                    throw NSError(domain: "AudioCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "System audio capture requires macOS 14.2+"])
                }
            }
        }

        while !CaptureRunnerSignalRelay.shared.shouldStop {
            let relay = CaptureRunnerSignalRelay.shared
            micCapture?.paused = relay.paused
            if #available(macOS 14.2, *) {
                let sys = systemCapture as? SystemAudioCapture
                sys?.paused = relay.paused
                if !relay.paused { sys?.recoverIfStalled() }
            }

            if let mic = micCapture, !relay.paused {
                mic.recoverIfStalled()

                if silenceTimeout > 0 {
                    let silentFor = Date().timeIntervalSince(mic.lastVoiceTime)
                    if silentFor > Double(silenceTimeout) {
                        fputs("Silence timeout: no voice for \(Int(silentFor))s (limit \(silenceTimeout)s)\n", stderr)
                        logJSON("warning", "silence_timeout", ["silent_seconds": Int(silentFor), "limit": silenceTimeout])
                        break
                    }
                }
            }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }

        stopAll()
        fputs("AudioCapture stopped\n", stderr)
        logJSON("info", "capture_stopped")
    }

    func stopAll() {
        _ = micCapture?.stop()
        if #available(macOS 14.2, *) {
            (systemCapture as? SystemAudioCapture)?.stop()
        }
    }
}

class CaptureRunnerSignalRelay {
    static let shared = CaptureRunnerSignalRelay()
    var shouldStop = false
    var paused = false

    func trigger() { shouldStop = true }
    func setPaused(_ value: Bool) { paused = value }
}
