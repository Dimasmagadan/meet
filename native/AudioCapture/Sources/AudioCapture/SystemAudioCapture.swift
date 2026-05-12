import Foundation
import ScreenCaptureKit
import CoreMedia
import AudioToolbox

class SystemAudioCapture: NSObject, SCStreamOutput {
    private var wavWriter: WAVWriter
    private var stream: SCStream?
    private let targetSampleRate: Int = 16000
    private var isRunning = false
    private let onChunkFinalized: (String) -> Void
    private var formatLogged = false

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

        guard let formatDesc = sampleBuffer.formatDescription,
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) else { return }
        let asbd = asbdPtr.pointee

        if !formatLogged {
            fputs("SystemAudio format: sampleRate=\(asbd.mSampleRate) channels=\(asbd.mChannelsPerFrame) formatID=\(asbd.mFormatID) bitsPerChannel=\(asbd.mBitsPerChannel) formatFlags=\(asbd.mFormatFlags)\n", stderr)
            formatLogged = true
        }

        guard let blockBuffer = sampleBuffer.dataBuffer else { return }

        var length = 0
        var dataPointer: UnsafeMutablePointer<CChar>?
        let status = CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &length, dataPointerOut: &dataPointer)
        guard status == kCMBlockBufferNoErr, dataPointer != nil, length > 0 else { return }

        let isFloat = asbd.mFormatID == kAudioFormatLinearPCM &&
                      (asbd.mFormatFlags & UInt32(kAudioFormatFlagIsFloat)) != 0

        let bytesPerSample = Int(asbd.mBytesPerFrame) / Int(asbd.mChannelsPerFrame)
        let frameCount = length / Int(asbd.mBytesPerFrame)

        var samples16 = [Int16]()
        samples16.reserveCapacity(frameCount)

        if isFloat && bytesPerSample == 4 {
            dataPointer?.withMemoryRebound(to: Float32.self, capacity: length / 4) { floatPtr in
                for i in 0..<frameCount {
                    let sample = Float32(floatPtr[i])
                    let clamped = max(-1.0, min(1.0, sample))
                    samples16.append(Int16(clamped * 32767.0))
                }
            }
        } else if isFloat && bytesPerSample == 8 {
            dataPointer?.withMemoryRebound(to: Float64.self, capacity: length / 8) { doublePtr in
                for i in 0..<frameCount {
                    let sample = Float32(doublePtr[i])
                    let clamped = max(-1.0, min(1.0, sample))
                    samples16.append(Int16(clamped * 32767.0))
                }
            }
        } else if !isFloat && bytesPerSample == 2 {
            dataPointer?.withMemoryRebound(to: Int16.self, capacity: length / 2) { intPtr in
                for i in 0..<frameCount {
                    samples16.append(intPtr[i].littleEndian)
                }
            }
        } else if !isFloat && bytesPerSample == 4 {
            dataPointer?.withMemoryRebound(to: Int32.self, capacity: length / 4) { intPtr in
                for i in 0..<frameCount {
                    samples16.append(Int16(clamping: intPtr[i] >> 16))
                }
            }
        } else {
            if !formatLogged {
                fputs("SystemAudio: unknown PCM format bytesPerSample=\(bytesPerSample) isFloat=\(isFloat), skipping\n", stderr)
            }
            return
        }

        do {
            let chunkReady = try wavWriter.appendSamplesIfNeeded(samples16)
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
