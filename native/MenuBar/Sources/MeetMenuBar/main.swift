import SwiftUI

if CommandLine.arguments.contains("--self-test-notch") {
    NotchPanelController.selfCheckTailExtraction()
    exit(0)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
