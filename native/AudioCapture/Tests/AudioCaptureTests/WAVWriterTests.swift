// The package target exists so native reliability seams can be exercised by
// `swift test` on toolchains that provide XCTest. This build environment omits
// XCTest/Swift Testing, so keep the target dependency-free for now.
enum AudioCaptureTestTarget {}
