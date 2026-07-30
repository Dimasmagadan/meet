import Foundation

// `node` + the args to launch `meet` headless: [main.js, start, <title>, --headless].
// resolved once by shelling out to `meet bin-path` (which keeps all path logic in TS)
// and cached for the app's lifetime.
struct Runner {
    let executable: String   // node path
    let args: [String]       // e.g. ["/…/dist/main.js", "start", "Weekly Standup", "--headless"]
}

final class RunnerResolver {
    private var cached: Runner?

    func resolve() -> Runner? {
        if let cached { return cached }
        guard let resolved = resolveUncached() else { return nil }
        cached = resolved
        return resolved
    }

    private func resolveUncached() -> Runner? {
        // GUI apps launch with a minimal PATH (/usr/bin:/bin:…); `meet` and `node`
        // usually live under /opt/homebrew/bin (Apple Silicon) or /usr/local/bin
        // (Intel). Augment PATH so the `meet` shim is reachable.
        guard let json = runMeetBinPath() else { return nil }
        guard let node = json["node"] as? String, !node.isEmpty,
              let main = json["main"] as? String, !main.isEmpty else { return nil }

        // Sanity: node must exist; main may be a realpath'd dist/main.js.
        guard FileManager.default.isExecutableFile(atPath: node) else { return nil }

        return Runner(executable: node, args: [main])
    }

    private func runMeetBinPath() -> [String: Any]? {
        var env = ProcessInfo.processInfo.environment
        let existing = env["PATH"] ?? ""
        var components = existing.split(separator: ":").map(String.init)
        for extra in ["/opt/homebrew/bin", "/usr/local/bin"] where !components.contains(extra) {
            components.append(extra)
        }
        env["PATH"] = components.joined(separator: ":")

        let proc = Process()
        proc.environment = env
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["meet", "bin-path"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
        } catch {
            return nil
        }
        proc.waitUntilExit()
        guard proc.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
