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

    func run() async throws {
        let runner = CaptureRunner(outputDir: outputDir, chunkDuration: chunkDuration, mode: mode)
        try await runner.run()
    }
}

@available(macOS 14.0, *)
class CaptureRunner {
    let outputDir: String
    let chunkDuration: Int
    let mode: String
    var micCapture: MicCapture?
    var systemCapture: SystemAudioCapture?
    var shouldStop = false

    init(outputDir: String, chunkDuration: Int, mode: String) {
        self.outputDir = outputDir
        self.chunkDuration = chunkDuration
        self.mode = mode
    }

    func run() async throws {
        let dir = URL(fileURLWithPath: outputDir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        signal(SIGINT) { _ in CaptureRunnerSignalRelay.shared.trigger() }
        signal(SIGTERM) { _ in CaptureRunnerSignalRelay.shared.trigger() }

        fputs("AudioCapture started: mode=\(mode) dir=\(outputDir)\n", stderr)

        if mode == "full" || mode == "mic" {
            let mic = MicCapture(outputDir: dir, chunkDurationSeconds: chunkDuration) { name in
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
            try await Task.sleep(nanoseconds: 500_000_000)
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
