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

    // P2-8 (SPEC_SAFETY_NET_2026-10-31 §6.1): attached CLI sessions have no
    // Process to observe — the lock's pid is the only liveness evidence.
    static func isPidAlive(_ pid: pid_t) -> Bool {
        kill(pid, 0) == 0
    }
}
