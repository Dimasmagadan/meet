import AVFoundation
import AppKit

// TCC preflight for Mic (SPEC_TCC_SCREEN_REPROMPT_2026-07-31 §5, §6). Pre-request from the app
// itself before spawning children, so Meet.app enters TCC first as the responsible process
// (bare child binaries like node/AudioCapture otherwise get unreliable prompts). Mic can be
// gated synchronously and refused on deny.
//
// System audio has no preflight here: since the Core Audio process tap rewrite (§6) it needs
// only "System Audio Recording Only" (kTCCServiceAudioCapture), which has no public
// CGPreflight-equivalent API. AudioCapture raises that prompt itself as the responsible
// process; failures are surfaced post-spawn via RecordingController.onCaptureFailed.
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
}

enum PrivacyPane: String {
    case microphone = "Privacy_Microphone"
    // Same underlying pane as before the Core Audio tap rewrite: System Settings merged Screen
    // Recording and System Audio Recording into one "Screen & System Audio Recording" pane
    // under this identifier.
    case screenCapture = "Privacy_ScreenCapture"
}

func openPrivacySettings(_ pane: PrivacyPane) {
    if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane.rawValue)") {
        NSWorkspace.shared.open(url)
    }
}
