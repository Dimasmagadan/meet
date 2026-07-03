import ArgumentParser
import FluidAudio
import Foundation

struct TranscribeCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "transcribe")

    @Option(name: .long, help: "Path to a 16kHz mono 16-bit PCM WAV file")
    var input: String

    func run() async throws {
        let startedAt = Date()

        let samples: [Float]
        do {
            samples = try WavIO.readMonoFloat32(path: input)
        } catch {
            JSONOutput.fail("failed to read input WAV: \(error)")
        }

        let manager = UnifiedAsrManager()
        do {
            try await manager.loadModels()
        } catch {
            JSONOutput.fail("failed to load Parakeet models: \(error)")
        }

        let text: String
        do {
            text = try await manager.transcribe(samples)
        } catch {
            JSONOutput.fail("transcription failed: \(error)")
        }

        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)

        JSONOutput.emit([
            "text": text,
            "durationMs": durationMs,
        ])
    }
}
