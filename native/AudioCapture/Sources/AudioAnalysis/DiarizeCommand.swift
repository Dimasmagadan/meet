import ArgumentParser
import FluidAudio
import Foundation

struct DiarizeCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "diarize")

    @Option(name: .long, help: "Path to a 16kHz mono 16-bit PCM WAV file")
    var input: String

    @Option(name: .long, help: "Minimum active frames for valid speech detection")
    var minActiveFrames: Float = 10.0

    func run() async throws {
        let startedAt = Date()

        let samples: [Float]
        do {
            samples = try WavIO.readMonoFloat32(path: input)
        } catch {
            JSONOutput.fail("failed to read input WAV: \(error)")
        }

        let config = DiarizerConfig(minActiveFramesCount: minActiveFrames)
        let manager = DiarizerManager(config: config)

        do {
            let models = try await DiarizerModels.downloadIfNeeded()
            manager.initialize(models: models)
        } catch {
            JSONOutput.fail("failed to load diarizer models: \(error)")
        }

        let result: DiarizationResult
        do {
            result = try manager.performCompleteDiarization(samples, sampleRate: 16000)
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

        JSONOutput.emit([
            "segments": segmentsJSON,
            "speakerCount": speakerIds.count,
            "durationMs": durationMs,
        ])
    }
}
