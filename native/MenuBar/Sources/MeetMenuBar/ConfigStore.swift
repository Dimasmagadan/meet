import Foundation

// Thin read/modify/write wrapper over ~/.meet/config.json — the same file
// src/storage.ts:loadConfig() reads. Round-trips as a raw [String: Any] so
// keys the Settings window doesn't expose (whisper thresholds, gate budgets,
// etc.) survive a save untouched.
enum ConfigStore {
    static let path: String =
        FileManager.default.homeDirectoryForCurrentUser.path + "/.meet/config.json"

    static func load() -> [String: Any] {
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return json
    }

    // Atomic replacement: the previous remove-then-move left a window where a
    // failure left config.json missing entirely (and a fixed ".tmp" name also
    // races concurrent savers). A uniquely named temp file plus a single
    // atomic replace keeps the previous config intact if publication fails.
    static func save(_ config: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let destURL = URL(fileURLWithPath: path)
        if FileManager.default.fileExists(atPath: path) {
            let tmpURL = URL(fileURLWithPath: path + ".\(UUID().uuidString).tmp")
            try data.write(to: tmpURL, options: .atomic)
            do {
                _ = try FileManager.default.replaceItemAt(destURL, withItemAt: tmpURL)
            } catch {
                try? FileManager.default.removeItem(at: tmpURL)
                throw error
            }
        } else {
            try data.write(to: destURL, options: .atomic)
        }
    }

    static func bool(_ config: [String: Any], _ key: String, default def: Bool) -> Bool {
        (config[key] as? NSNumber)?.boolValue ?? def
    }

    static func string(_ config: [String: Any], _ key: String, default def: String) -> String {
        (config[key] as? String) ?? def
    }

    static func int(_ config: [String: Any], _ key: String, default def: Int) -> Int {
        (config[key] as? NSNumber)?.intValue ?? def
    }

    static func double(_ config: [String: Any], _ key: String, default def: Double) -> Double {
        (config[key] as? NSNumber)?.doubleValue ?? def
    }
}
