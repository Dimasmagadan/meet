import ArgumentParser
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

    func run() async throws {
        let runner = CaptureRunner(outputDir: outputDir, chunkDuration: chunkDuration, mode: mode, silenceTimeout: silenceTimeout, voiceProcessing: voiceProcessing)
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
    var micCapture: MicCapture?
    var systemCapture: SystemAudioCapture?
    var shouldStop = false

    init(outputDir: String, chunkDuration: Int, mode: String, silenceTimeout: Int, voiceProcessing: Bool) {
        self.outputDir = outputDir
        self.chunkDuration = chunkDuration
        self.mode = mode
        self.silenceTimeout = silenceTimeout
        self.voiceProcessing = voiceProcessing
    }

    func run() async throws {
        let dir = URL(fileURLWithPath: outputDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        signal(SIGINT) { _ in CaptureRunnerSignalRelay.shared.trigger() }
        signal(SIGTERM) { _ in CaptureRunnerSignalRelay.shared.trigger() }

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
                if mode == "mic" { throw error }
            }
        }

        if mode == "full" {
            let sys = SystemAudioCapture(outputDir: dir, chunkDurationSeconds: chunkDuration) { name in
                let idx = Int(name.replacingOccurrences(of: "sys-", with: "").replacingOccurrences(of: ".wav", with: "")) ?? 0
                logJSON("info", "chunk_finalized", ["source": "sys", "filename": name, "index": idx])
            }
            do {
                try await sys.start()
                systemCapture = sys
                fputs("System audio capture started\n", stderr)
                logJSON("info", "stream_started", ["source": "sys"])
            } catch {
                fputs("System audio capture failed: \(error)\n", stderr)
                logJSON("error", "stream_error", ["source": "sys", "message": String(describing: error)])
            }
        }

        while !CaptureRunnerSignalRelay.shared.shouldStop {
            if let mic = micCapture {
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
        systemCapture?.stop()
    }
}

class CaptureRunnerSignalRelay {
    static let shared = CaptureRunnerSignalRelay()
    var shouldStop = false
    func trigger() { shouldStop = true }
}
