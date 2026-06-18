// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MeetMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "MeetMenuBar",
            path: "Sources/MeetMenuBar"
        )
    ]
)
