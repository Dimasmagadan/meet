// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AudioCapture",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-argument-parser", from: "1.3.0"),
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.12.4"),
    ],
    targets: [
        .executableTarget(
            name: "AudioCapture",
            dependencies: [.product(name: "ArgumentParser", package: "swift-argument-parser")],
            path: "Sources/AudioCapture",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])]
        ),
        .executableTarget(
            name: "AudioAnalysis",
            dependencies: [
                .product(name: "ArgumentParser", package: "swift-argument-parser"),
                .product(name: "FluidAudio", package: "FluidAudio"),
            ],
            path: "Sources/AudioAnalysis",
            swiftSettings: [.unsafeFlags(["-parse-as-library"])]
        ),
    ]
)
