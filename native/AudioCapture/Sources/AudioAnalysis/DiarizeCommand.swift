import ArgumentParser
import FluidAudio
import Foundation

struct DiarizeCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "diarize")

    @Option(name: .long, help: "Path to a 16kHz mono 16-bit PCM WAV file")
    var input: String

    @Option(name: .long, help: "Minimum active frames for valid speech detection")
    var minActiveFrames: Float = 10.0

    @Flag(name: .long, help: "Use the offline VBx pipeline (batch-optimized) instead of the online pipeline (S2 A/B)")
    var offline: Bool = false

    func run() async throws {
        let startedAt = Date()

        let samples: [Float]
        do {
            samples = try WavIO.readMonoFloat32(path: input)
        } catch {
            JSONOutput.fail("failed to read input WAV: \(error)")
        }

        let result: DiarizationResult
        do {
            result = offline ? try await runOffline(samples: samples) : try await runOnline(samples: samples)
        } catch {
            JSONOutput.fail("diarization failed: \(error)")
        }

        let durationMs = Int(Date().timeIntervalSince(startedAt) * 1000)
        let speakerIds = Set(result.segments.map { $0.speakerId })

        let segmentsJSON = result.segments.map { segment -> [String: Any] in
            [
                "start": Double(segment.startTimeSeconds),
                "end": Double(segment.endTimeSeconds),
                "speaker": segment.speakerId,
            ]
        }

        // Both pipelines return DiarizationResult; `speakerDatabase` is where each
        // one's per-speaker embeddings (256-d) land — populated below for the
        // online path (from speakerManager) and natively by OfflineDiarizerManager
        // for the offline path. Filtered to segment-derived ids: assignSpeaker
        // registers a DB entry on total speech duration, but createSegmentIfValid
        // drops each run below minSpeechDuration — so fragmented backchannel can
        // sit in the DB with zero segments. Keeping them would seed phantom
        // identities into the registry.
        let embeddingsJSON = (result.speakerDatabase ?? [:])
            .filter { speakerIds.contains($0.key) }
            .reduce(into: [String: [Double]]()) { acc, entry in
                acc[entry.key] = entry.value.map { Double($0) }
            }

        JSONOutput.emit([
            "segments": segmentsJSON,
            "speakerCount": speakerIds.count,
            "durationMs": durationMs,
            "embeddings": embeddingsJSON,
        ])
    }

    private func runOnline(samples: [Float]) async throws -> DiarizationResult {
        let config = DiarizerConfig(minActiveFramesCount: minActiveFrames)
        let manager = DiarizerManager(config: config)
        let models = try await DiarizerModels.downloadIfNeeded()
        manager.initialize(models: models)
        let result = try manager.performCompleteDiarization(samples, sampleRate: 16000)
        let embeddings = manager.speakerManager.getAllSpeakers()
            .reduce(into: [String: [Float]]()) { acc, entry in acc[entry.key] = entry.value.currentEmbedding }
        return DiarizationResult(segments: result.segments, speakerDatabase: embeddings)
    }

    // OfflineDiarizerManager (VBx clustering, community-1 models) — S2 A/B pass.
    // Same 13 MB model repo as the online pipeline (already on disk); `.process`
    // lazily loads/downloads via `prepareModels()` if not yet initialized.
    private func runOffline(samples: [Float]) async throws -> DiarizationResult {
        let manager = OfflineDiarizerManager()
        return try await manager.process(audio: samples)
    }
}
