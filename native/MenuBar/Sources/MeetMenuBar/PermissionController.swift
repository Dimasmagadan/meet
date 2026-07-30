import AVFoundation
import CoreGraphics
import AppKit

// TCC preflight for Mic + Screen Recording (SPEC §5). We implement branches A + B as the
// default baseline (the spike may refine this): pre-request from the app *itself* before
// spawning children, so Meet.app enters TCC first as the responsible process (bare child
// binaries like node/AudioCapture otherwise get unreliable prompts). Mic can be gated
// synchronously; screen capture's request API cannot return the user's live choice, so it
// only triggers the prompt and fails open.
final class PermissionController {
    /// Pre-request microphone access. Returns false only when explicitly denied/restricted
    /// (branch A refuse-to-start). Fail-open on @unknown states.
    func ensureMic() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { cont in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    cont.resume(returning: granted)
                }
            }
        case .denied, .restricted:
            return false
        @unknown default:
            return true
        }
    }

    /// Preflight screen capture; if not already granted, trigger the TCC prompt so Meet.app
    /// enters the screen-capture authorization first. Cannot synchronously read the user's
    /// choice, so this never hard-blocks — it returns whether access was already granted
    /// before the call (informational; recording proceeds either way).
    @discardableResult
    func ensureScreen() -> Bool {
        if CGPreflightScreenCaptureAccess() { return true }
        _ = CGRequestScreenCaptureAccess()
        return false
    }
}

enum PrivacyPane: String {
    case microphone = "Privacy_Microphone"
    case screenCapture = "Privacy_ScreenCapture"
}

func openPrivacySettings(_ pane: PrivacyPane) {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane.rawValue)") {
        NSWorkspace.shared.open(url)
    }
}
