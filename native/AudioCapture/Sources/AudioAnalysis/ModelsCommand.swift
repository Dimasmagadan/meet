import ArgumentParser
import FluidAudio
import Foundation

struct ModelsCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(commandName: "models")

    @Flag(name: .long, help: "Download and verify diarizer + ASR models are ready")
    var ensure: Bool = false

    func run() async throws {
        guard ensure else {
            JSONOutput.fail("models requires --ensure")
        }

        var diarizerStatus = "ok"
        do {
            _ = try await DiarizerModels.downloadIfNeeded()
        } catch {
            diarizerStatus = "error: \(error)"
        }

        var asrStatus = "ok"
        do {
            _ = try await AsrModels.downloadAndLoad()
        } catch {
            asrStatus = "error: \(error)"
        }

        let cacheDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("FluidAudio", isDirectory: true)
            .path

        JSONOutput.emit([
            "diarizer": diarizerStatus,
            "asr": asrStatus,
            "cacheDir": cacheDir,
        ])

        if diarizerStatus != "ok" || asrStatus != "ok" {
            Foundation.exit(1)
        }
    }
}
