import Foundation

enum JSONOutput {
    /// Serializes `object` (a JSONSerialization-compatible value: dictionaries,
    /// arrays, strings, numbers, bools) to stdout as a single line of JSON.
    static func emit(_ object: Any) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            fputs("{\"error\":\"failed to serialize output\"}\n", stderr)
            exit(1)
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }

    static func fail(_ message: String) -> Never {
        fputs("AudioAnalysis error: \(message)\n", stderr)
        exit(1)
    }
}
