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
        guard let json = ActiveLock.read(),
              let sessionDir = json["sessionDir"] as? String else { return }
        onRecordingDetected?(sessionDir)
    }
}
