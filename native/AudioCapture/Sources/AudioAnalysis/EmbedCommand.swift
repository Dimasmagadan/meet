import ArgumentParser
import FluidAudio
import Foundation

struct EmbedCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "embed")

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

        // Single-utterance voiceprint via the same WeSpeaker model the full
        // diarization pass uses. Cheap (ANE) so the live pipeline can call it
        // once per chunk; matching against the registry happens on the Node
        // side. NOTE: a chunk-level embedding has a slightly different
        // distribution than an EMA-pooled whole-meeting centroid — Node keeps
        // a separate (lower) live match threshold for this reason.
        let manager = DiarizerManager()
        do {
            let models = try await DiarizerModels.downloadIfNeeded()
            manager.initialize(models: models)
        } catch {
            JSONOutput.fail("failed to load diarizer models: \(error)")
        }

        let embedding: [Float]
        do {
            embedding = try manager.extractSpeakerEmbedding(from: samples)
        } catch {
            JSONOutput.fail("embedding extraction failed: \(error)")
        }

        JSONOutput.emit([
            "embedding": embedding.map(Double.init),
            "durationMs": Int(Date().timeIntervalSince(startedAt) * 1000),
        ])
    }
}
