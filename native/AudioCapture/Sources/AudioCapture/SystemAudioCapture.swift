import Foundation
import ScreenCaptureKit
import CoreMedia

class SystemAudioCapture: NSObject, SCStreamOutput {
    private var wavWriter: WAVWriter
    private var stream: SCStream?
    private let targetSampleRate: Int = 16000
    private var isRunning = false
    private let onChunkFinalized: (String) -> Void

    init(outputDir: URL, chunkDurationSeconds: Int, onChunkFinalized: @escaping (String) -> Void) {
        self.wavWriter = WAVWriter(outputDir: outputDir, prefix: "sys", chunkDurationSeconds: chunkDurationSeconds)
        self.onChunkFinalized = onChunkFinalized
        super.init()
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        guard let display = content.displays.first else {
            throw CaptureError.noDisplay
        }

        let filter = SCContentFilter(display: display, excludingWindows: [])

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 16_000
        config.channelCount = 1
        config.width = 2
        config.height = 2
        config.showsCursor = false

        stream = SCStream(filter: filter, configuration: config, delegate: nil)
        guard let stream else { throw CaptureError.streamCreationFailed }

        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "meet.sysaudio"))

        try wavWriter.startChunk()
        isRunning = true

        try await stream.startCapture()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard isRunning, type == .audio else { return }
        guard let blockBuffer = sampleBuffer.dataBuffer else { return }

        var length = 0
        var dataPointer: UnsafeMutablePointer<CChar>?
        let status = CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer)
        guard status == kCMBlockBufferNoErr, dataPointer != nil, length > 0 else { return }

        let sampleCount = length / 2
        var samples = [Int16]()
        samples.reserveCapacity(sampleCount)
        dataPointer?.withMemoryRebound(to: Int16.self, capacity: sampleCount) { ptr in
            for i in 0..<sampleCount {
                samples.append(ptr[i].bigEndian == ptr[i] ? Int16(bigEndian: ptr[i]) : ptr[i])
            }
        }

        do {
            let chunkReady = try wavWriter.appendSamplesIfNeeded(samples)
            if chunkReady {
                if let name = try wavWriter.finalizeChunk() {
                    onChunkFinalized(name)
                }
                try wavWriter.startChunk()
            }
        } catch {
            fputs("SystemAudioCapture write error: \(error)\n", stderr)
        }
    }

    func stop() {
        isRunning = false
        if let stream {
            Task {
                try? await stream.stopCapture()
            }
        }
        _ = try? wavWriter.flushPartial()
    }
}

enum CaptureError: LocalizedError {
    case noDisplay
    case streamCreationFailed
    case permissionDenied

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "No display found for screen capture"
        case .streamCreationFailed: return "Failed to create SCStream"
        case .permissionDenied: return "Screen Recording permission required. Open System Settings → Privacy & Security → Screen Recording."
        }
    }
}
