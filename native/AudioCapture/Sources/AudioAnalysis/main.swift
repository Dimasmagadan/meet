import ArgumentParser
import Foundation

@main
struct AudioAnalysisCLI: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "AudioAnalysis",
        subcommands: [DiarizeCommand.self, EmbedCommand.self, TranscribeCommand.self, ModelsCommand.self]
    )
}
