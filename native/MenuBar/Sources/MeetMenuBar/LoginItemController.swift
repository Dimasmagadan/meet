import Foundation
import ServiceManagement

// Launch-at-login via SMAppService.mainApp (macOS 13+). Replaces the deprecated
// SMLoginItemSetEnabled and requires Meet to be a bundled, signed .app — hence Phase 0
// is a hard prerequisite.
final class LoginItemController {
    private let service = SMAppService.mainApp

    var isEnabled: Bool {
        // .requiresApproval = the user toggled it off in System Settings but we're still
        // registered; treat as enabled-on-our-side so the menu reflects intent.
        service.status == .enabled || service.status == .requiresApproval
    }

    func enable() throws {
        try service.register()
    }

    func disable() throws {
        try service.unregister()
    }
}
