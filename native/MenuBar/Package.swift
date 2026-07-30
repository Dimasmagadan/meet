// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MeetMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "MeetMenuBar",
            path: "Sources/MeetMenuBar",
            // ServiceManagement is a system framework (SMAppService), not a SwiftPM
            // package — link it explicitly so Launch-at-Login resolves without an Xcode project.
            linkerSettings: [.linkedFramework("ServiceManagement")]
        )
    ]
)
