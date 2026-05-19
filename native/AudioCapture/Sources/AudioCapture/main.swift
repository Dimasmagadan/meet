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

        if mode == "full" || mode == "mic" {
            let mic = MicCapture(outputDir: dir, chunkDurationSeconds: chunkDuration, voiceProcessing: voiceProcessing) { name in
                fputs("finalized: \(name)\n", stderr)
            }
            do {
                try mic.start()
                micCapture = mic
                fputs("Mic capture started\n", stderr)
            } catch {
                fputs("Mic capture failed: \(error)\n", stderr)
                if mode == "mic" { throw error }
            }
        }

        if mode == "full" {
            let sys = SystemAudioCapture(outputDir: dir, chunkDurationSeconds: chunkDuration) { name in
                fputs("finalized: \(name)\n", stderr)
            }
            do {
                try await sys.start()
                systemCapture = sys
                fputs("System audio capture started\n", stderr)
            } catch {
                fputs("System audio capture failed: \(error)\n", stderr)
            }
        }

        while !CaptureRunnerSignalRelay.shared.shouldStop {
            if silenceTimeout > 0, let mic = micCapture {
                let silentFor = Date().timeIntervalSince(mic.lastVoiceTime)
                if silentFor > Double(silenceTimeout) {
                    fputs("Silence timeout: no voice for \(Int(silentFor))s (limit \(silenceTimeout)s)\n", stderr)
                    break
                }
            }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }

        stopAll()
        fputs("AudioCapture stopped\n", stderr)
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
