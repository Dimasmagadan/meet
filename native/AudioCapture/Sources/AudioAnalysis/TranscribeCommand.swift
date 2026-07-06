import ArgumentParser
import FluidAudio
import Foundation

struct TranscribeCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "transcribe")

    @Option(name: .long, help: "Path to a 16kHz mono 16-bit PCM WAV file")
    var input: String

    @Option(name: .long, help: "ISO language code for script-aware token filtering (e.g. ru, en)")
    var language: String?

    func run() async throws {
        let startedAt = Date()

        let samples: [Float]
        do {
            samples = try WavIO.readMonoFloat32(path: input)
        } catch {
            JSONOutput.fail("failed to read input WAV: \(error)")
        }

        let models: AsrModels
        do {
            models = try await AsrModels.downloadAndLoad()
        } catch {
            JSONOutput.fail("failed to load Parakeet models: \(error)")
        }

        let manager = AsrManager(models: models)
        var decoderState: TdtDecoderState
        do {
            decoderState = try TdtDecoderState(decoderLayers: await manager.decoderLayerCount)
        } catch {
            JSONOutput.fail("failed to init decoder state: \(error)")
        }

        let languageHint = language.flatMap { Language(rawValue: $0) }

        let text: String
        do {
            let result = try await manager.transcribe(samples, decoderState: &decoderState, language: languageHint)
            text = result.text
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
