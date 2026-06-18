import Foundation

class SessionMonitor {
    var onRecordingDetected: ((String) -> Void)?

    private var timer: Timer?

    func start() {
        checkForActiveSession()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            self?.checkForActiveSession()
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func checkForActiveSession() {
        let lockPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".meet/sessions/active-recording.lock")

        guard let data = FileManager.default.contents(atPath: lockPath.path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sessionDir = json["sessionDir"] as? String else { return }

        onRecordingDetected?(sessionDir)
    }
}
