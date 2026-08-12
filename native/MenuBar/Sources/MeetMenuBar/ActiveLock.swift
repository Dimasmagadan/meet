import Foundation

// Shared reader for ~/.meet/sessions/active-recording.lock — collapses the
// hand-rolled copies that were scattered across NotchPanelController,
// RecordingController, and SessionMonitor. Returns the raw JSON dict; callers
// extract the fields they need and do their own validation (PID liveness, etc.).
enum ActiveLock {
    static let path = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".meet/sessions/active-recording.lock")

    static func read() -> [String: Any]? {
        guard let data = FileManager.default.contents(atPath: path.path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json
    }

    static func exists() -> Bool {
        FileManager.default.fileExists(atPath: path.path)
    }
}
