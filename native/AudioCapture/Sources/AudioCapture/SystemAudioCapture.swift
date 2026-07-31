import Foundation
import CoreAudio
import AudioToolbox

// Core Audio process tap (macOS 14.2+), replacing the prior ScreenCaptureKit-based capture.
// SCK required full Screen Recording TCC for what was audio-only capture (mismatch also hit by
// OBS: https://github.com/obsproject/obs-studio/issues/10401) and was subject to periodic
// re-approval nags. A process tap only needs the narrower "System Audio Recording Only"
// permission and has no such nag. See specs/SPEC_TCC_SCREEN_REPROMPT_2026-07-31.md §6.
//
// CATapDescription's convenience initializers are all NS_REFINED_FOR_SWIFT with no Swift overlay
// shipped in this SDK, so Swift only sees the double-underscore-prefixed selectors
// (confirmed via `swiftc -typecheck` against the actual SDK headers, not guessed).
@available(macOS 14.2, *)
class SystemAudioCapture {
    private var wavWriter: WAVWriter
    private var outputDir: URL
    private var chunkDurationSeconds: Int
    private let targetSampleRate: Int = 16000
    private var isRunning = false
    private let onChunkFinalized: (String) -> Void
    private var formatLogged = false
    private var isRestarting = false
    private var restartCount = 0
    private var lastRestartTime: Date = Date.distantPast
    private(set) var lastBufferTime: Date = Date()
    var paused = false

    private var tapID: AudioObjectID = kAudioObjectUnknown
    private var aggregateDeviceID: AudioObjectID = kAudioObjectUnknown
    private var ioProcID: AudioDeviceIOProcID?
    private var sourceSampleRate: Double = 48000
    private var sourceChannelCount: Int = 1

    init(outputDir: URL, chunkDurationSeconds: Int, onChunkFinalized: @escaping (String) -> Void) {
        self.outputDir = outputDir
        self.chunkDurationSeconds = chunkDurationSeconds
        self.wavWriter = WAVWriter(outputDir: outputDir, prefix: "sys", chunkDurationSeconds: chunkDurationSeconds)
        self.onChunkFinalized = onChunkFinalized
    }

    func start() throws {
        try startTap(reason: restartCount == 0 ? "initial" : "restart")
    }

    private func startTap(reason: String) throws {
        let ownProcessObjectID = try Self.processObjectID(pid: getpid())

        let description = CATapDescription(__monoGlobalTapButExcludeProcesses: [NSNumber(value: ownProcessObjectID)])
        description.name = "meet-sys-tap-\(getpid())"
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var newTapID: AudioObjectID = kAudioObjectUnknown
        let tapStatus = AudioHardwareCreateProcessTap(description, &newTapID)
        guard tapStatus == noErr else { throw CaptureError.tapCreationFailed(tapStatus) }
        tapID = newTapID

        let outputUID = try Self.deviceUID(Self.defaultSystemOutputDeviceID())
        let aggregateUID = "com.dimasmagadan.meet.systap.\(UUID().uuidString)"

        let aggregateDict: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Meet System Audio Tap",
            kAudioAggregateDeviceUIDKey: aggregateUID,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [
                [kAudioSubDeviceUIDKey: outputUID],
            ],
            kAudioAggregateDeviceTapListKey: [
                [
                    kAudioSubTapUIDKey: description.uuid.uuidString,
                    kAudioSubTapDriftCompensationKey: true,
                ],
            ],
        ]

        var newAggregateID: AudioObjectID = kAudioObjectUnknown
        let aggregateStatus = AudioHardwareCreateAggregateDevice(aggregateDict as CFDictionary, &newAggregateID)
        guard aggregateStatus == noErr else { throw CaptureError.aggregateDeviceCreationFailed(aggregateStatus) }
        aggregateDeviceID = newAggregateID

        let format = try Self.inputStreamFormat(aggregateDeviceID)
        sourceSampleRate = format.mSampleRate > 0 ? format.mSampleRate : 48000
        sourceChannelCount = max(1, Int(format.mChannelsPerFrame))

        if !formatLogged {
            fputs("SystemAudio tap format: sampleRate=\(sourceSampleRate) channels=\(sourceChannelCount)\n", stderr)
            formatLogged = true
        }

        if !wavWriter.isChunkOpen {
            try wavWriter.startChunk()
        }

        var newIOProcID: AudioDeviceIOProcID?
        let ioStatus = AudioDeviceCreateIOProcIDWithBlock(&newIOProcID, aggregateDeviceID, nil) { [weak self] _, inputData, _, _, _ in
            self?.handleInput(inputData)
        }
        guard ioStatus == noErr, let procID = newIOProcID else {
            throw CaptureError.ioProcCreationFailed(ioStatus)
        }
        ioProcID = procID

        let startStatus = AudioDeviceStart(aggregateDeviceID, procID)
        guard startStatus == noErr else { throw CaptureError.deviceStartFailed(startStatus) }

        isRunning = true
        lastBufferTime = Date()
        logJSON("info", "sys_stream_started", ["reason": reason, "restart_count": restartCount])
    }

    private func handleInput(_ inputData: UnsafePointer<AudioBufferList>) {
        guard isRunning else { return }
        lastBufferTime = Date()
        guard !paused else { return }

        let bufferList = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
        guard let buffer = bufferList.first, let mData = buffer.mData else { return }

        let channels = max(1, Int(buffer.mNumberChannels))
        let frameCount = Int(buffer.mDataByteSize) / MemoryLayout<Float32>.size / channels
        guard frameCount > 0 else { return }

        let floatPtr = mData.assumingMemoryBound(to: Float32.self)
        var monoSamples = [Int16]()
        monoSamples.reserveCapacity(frameCount)
        for i in 0..<frameCount {
            let sample = floatPtr[i * channels]
            let clamped = max(-1.0, min(1.0, sample))
            monoSamples.append(Int16(clamped * 32767.0))
        }

        let ratio = sourceSampleRate / Double(targetSampleRate)
        let resampled = linearInterpolate(monoSamples, ratio: ratio)

        do {
            let chunkReady = try wavWriter.appendSamplesIfNeeded(resampled)
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

    private func linearInterpolate(_ samples: [Int16], ratio: Double) -> [Int16] {
        guard ratio > 1.0, !samples.isEmpty else { return samples }
        let outputCount = Int(Double(samples.count) / ratio)
        guard outputCount > 0 else { return samples }

        var result = [Int16]()
        result.reserveCapacity(outputCount)
        for i in 0..<outputCount {
            let srcPos = Double(i) * ratio
            let index = Int(srcPos)
            let frac = srcPos - Double(index)
            if index + 1 < samples.count {
                let s0 = Double(samples[index])
                let s1 = Double(samples[index + 1])
                result.append(Int16(s0 + frac * (s1 - s0)))
            } else if index < samples.count {
                result.append(samples[index])
            }
        }
        return result
    }

    func recoverIfStalled(thresholdSeconds: TimeInterval = 3.0) {
        guard isRunning else { return }
        let stalledFor = Date().timeIntervalSince(lastBufferTime)
        if stalledFor > thresholdSeconds {
            restartTap(reason: "buffer_stall_\(Int(stalledFor))s")
        }
    }

    private func restartTap(reason: String) {
        guard isRunning, !isRestarting else { return }
        let now = Date()
        if now.timeIntervalSince(lastRestartTime) < 5.0 { return }
        lastRestartTime = now
        isRestarting = true
        defer { isRestarting = false }

        teardownTap()
        restartCount += 1
        fputs("SystemAudioCapture restarting: \(reason) (#\(restartCount))\n", stderr)
        logJSON("warning", "sys_restart", ["reason": reason, "restart_count": restartCount])

        do {
            try startTap(reason: reason)
        } catch {
            isRunning = false
            fputs("SystemAudioCapture restart failed: \(error)\n", stderr)
            logJSON("error", "sys_restart_failed", [
                "reason": reason,
                "restart_count": restartCount,
                "message": String(describing: error),
            ])
        }
    }

    private func teardownTap() {
        if let procID = ioProcID {
            AudioDeviceStop(aggregateDeviceID, procID)
            AudioDeviceDestroyIOProcID(aggregateDeviceID, procID)
            ioProcID = nil
        }
        if aggregateDeviceID != kAudioObjectUnknown {
            AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = kAudioObjectUnknown
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = kAudioObjectUnknown
        }
    }

    func stop() {
        isRunning = false
        teardownTap()
        _ = try? wavWriter.flushPartial()
    }

    private static func processObjectID(pid: pid_t) throws -> AudioObjectID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var pidVar = pid
        var objectID: AudioObjectID = kAudioObjectUnknown
        var dataSize = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = withUnsafeMutablePointer(to: &pidVar) { pidPtr -> OSStatus in
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject), &address,
                UInt32(MemoryLayout<pid_t>.size), pidPtr,
                &dataSize, &objectID
            )
        }
        guard status == noErr else { throw CaptureError.processLookupFailed(status) }
        guard objectID != kAudioObjectUnknown else { throw CaptureError.processObjectNotFound }
        return objectID
    }

    private static func defaultSystemOutputDeviceID() throws -> AudioObjectID {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultSystemOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var deviceID: AudioObjectID = kAudioObjectUnknown
        var dataSize = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &deviceID)
        guard status == noErr else { throw CaptureError.outputDeviceUnavailable(status) }
        return deviceID
    }

    private static func deviceUID(_ deviceID: AudioObjectID) throws -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uid: Unmanaged<CFString>?
        var dataSize = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, &uid)
        guard status == noErr, let uid else { throw CaptureError.outputDeviceUnavailable(status) }
        return uid.takeRetainedValue() as String
    }

    private static func inputStreamFormat(_ deviceID: AudioObjectID) throws -> AudioStreamBasicDescription {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamFormat,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var format = AudioStreamBasicDescription()
        var dataSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, &format)
        guard status == noErr else { throw CaptureError.streamFormatUnavailable(status) }
        return format
    }
}

enum CaptureError: LocalizedError {
    case processLookupFailed(OSStatus)
    case processObjectNotFound
    case tapCreationFailed(OSStatus)
    case aggregateDeviceCreationFailed(OSStatus)
    case ioProcCreationFailed(OSStatus)
    case deviceStartFailed(OSStatus)
    case outputDeviceUnavailable(OSStatus)
    case streamFormatUnavailable(OSStatus)

    var errorDescription: String? {
        switch self {
        case .processLookupFailed(let status): return "Failed to look up own process audio object (status \(status))"
        case .processObjectNotFound: return "Own process audio object not found"
        case .tapCreationFailed(let status): return "Failed to create Core Audio process tap (status \(status)). Requires System Audio Recording permission in System Settings → Privacy & Security."
        case .aggregateDeviceCreationFailed(let status): return "Failed to create aggregate device for tap (status \(status))"
        case .ioProcCreationFailed(let status): return "Failed to create IO proc for tap aggregate device (status \(status))"
        case .deviceStartFailed(let status): return "Failed to start tap aggregate device (status \(status))"
        case .outputDeviceUnavailable(let status): return "Failed to resolve default system output device (status \(status))"
        case .streamFormatUnavailable(let status): return "Failed to read tap stream format (status \(status))"
        }
    }
}
