import AVFoundation

@available(macOS 14.0, *)
class MicCapture {
    private let engine = AVAudioEngine()
    private var wavWriter: WAVWriter
    private let targetSampleRate: Int = 16000
    private let voiceProcessing: Bool
    private var isRunning = false
    private var isRestarting = false
    private let onChunkFinalized: (String) -> Void
    private var formatLogged = false
    private(set) var lastVoiceTime: Date = Date()
    private(set) var lastBufferTime: Date = Date()
    private let voiceRmsThreshold: Float = 200.0
    private var configObserver: NSObjectProtocol?
    private var restartCount = 0
    private var lastRestartTime: Date = Date.distantPast

    init(outputDir: URL, chunkDurationSeconds: Int, voiceProcessing: Bool = false, onChunkFinalized: @escaping (String) -> Void) {
        self.wavWriter = WAVWriter(outputDir: outputDir, prefix: "mic", chunkDurationSeconds: chunkDurationSeconds)
        self.voiceProcessing = voiceProcessing
        self.onChunkFinalized = onChunkFinalized
    }

    func start() throws {
        if !wavWriter.isChunkOpen {
            try wavWriter.startChunk()
        }
        installConfigurationObserverIfNeeded()
        try startEngine(reason: restartCount == 0 ? "initial" : "restart")
        isRunning = true
        lastBufferTime = Date()
    }

    private func startEngine(reason: String) throws {
        let inputNode = engine.inputNode
        let _ = inputNode.outputFormat(forBus: 0)

        if voiceProcessing {
            try inputNode.setVoiceProcessingEnabled(true)

            inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(
                enableAdvancedDucking: false,
                duckingLevel: .min
            )
        }

        let vpFormat = inputNode.outputFormat(forBus: 0)
        let hwSampleRate = vpFormat.sampleRate
        let hwChannels = vpFormat.channelCount
        let hwIsInterleaved = vpFormat.isInterleaved
        let ratio = Double(hwSampleRate) / Double(targetSampleRate)

        if !formatLogged {
            fputs("MicCapture VP format: rate=\(hwSampleRate) channels=\(hwChannels) interleaved=\(hwIsInterleaved)\n", stderr)
            formatLogged = true
        }

        inputNode.removeTap(onBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: vpFormat) { [weak self] buffer, _ in
            guard let self, self.isRunning else { return }
            self.processBuffer(buffer, hwSampleRate: hwSampleRate, hwChannels: hwChannels, isInterleaved: hwIsInterleaved, ratio: ratio)
        }

        try engine.start()
        logJSON("info", "mic_engine_started", [
            "reason": reason,
            "sample_rate": hwSampleRate,
            "channels": Int(hwChannels),
            "interleaved": hwIsInterleaved,
            "restart_count": restartCount,
        ])
    }

    private func installConfigurationObserverIfNeeded() {
        guard configObserver == nil else { return }
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            self?.handleEngineConfigurationChange()
        }
    }

    private func handleEngineConfigurationChange() {
        guard isRunning else { return }
        fputs("MicCapture configuration changed; restarting tap\n", stderr)
        logJSON("warning", "mic_engine_config_changed", ["restart_count": restartCount])
        restartCapture(reason: "engine_config_changed")
    }

    private func restartCapture(reason: String) {
        guard isRunning, !isRestarting else { return }
        let now = Date()
        if now.timeIntervalSince(lastRestartTime) < 5.0 { return }
        lastRestartTime = now
        isRestarting = true
        defer { isRestarting = false }

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()

        restartCount += 1
        fputs("MicCapture restarting: \(reason) (#\(restartCount))\n", stderr)
        logJSON("warning", "mic_restart", ["reason": reason, "restart_count": restartCount])

        do {
            try startEngine(reason: reason)
            lastBufferTime = Date()
        } catch {
            fputs("MicCapture restart failed: \(error)\n", stderr)
            logJSON("error", "mic_restart_failed", [
                "reason": reason,
                "restart_count": restartCount,
                "message": String(describing: error),
            ])
        }
    }

    func recoverIfStalled(thresholdSeconds: TimeInterval = 3.0) {
        guard isRunning else { return }
        let stalledFor = Date().timeIntervalSince(lastBufferTime)
        if stalledFor > thresholdSeconds {
            restartCapture(reason: "buffer_stall_\(Int(stalledFor))s")
        }
    }

    private func processBuffer(_ buffer: AVAudioPCMBuffer, hwSampleRate: Float64, hwChannels: AVAudioChannelCount, isInterleaved: Bool, ratio: Double) {
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return }
        lastBufferTime = Date()

        var monoSamples = [Int16]()

        if let floatData = buffer.floatChannelData {
            let ch: Int
            if isInterleaved || hwChannels <= 1 {
                ch = 0
            } else {
                ch = findLoudestChannel(floatData, channelCount: Int(hwChannels), frameLength: frameLength)
            }
            for i in 0..<frameLength {
                let sample = floatData[ch][i]
                let clamped = max(-1.0, min(1.0, sample))
                monoSamples.append(Int16(clamped * 32767.0))
            }
        } else if let int16Data = buffer.int16ChannelData {
            for i in 0..<frameLength {
                monoSamples.append(int16Data[0][i])
            }
        }

        guard !monoSamples.isEmpty else { return }

        let rms: Double = sqrt(monoSamples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(monoSamples.count))
        if Float(rms) > voiceRmsThreshold {
            lastVoiceTime = Date()
        }

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
            fputs("MicCapture write error: \(error)\n", stderr)
        }
    }

    private func findLoudestChannel(_ floatData: UnsafePointer<UnsafeMutablePointer<Float>>, channelCount: Int, frameLength: Int) -> Int {
        guard channelCount > 1 else { return 0 }
        var bestCh = 0
        var bestEnergy: Float = -1
        for ch in 0..<channelCount {
            let ptr = floatData[ch]
            var energy: Float = 0
            for i in 0..<frameLength {
                energy += ptr[i] * ptr[i]
            }
            if energy > bestEnergy {
                bestEnergy = energy
                bestCh = ch
            }
        }
        return bestCh
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

    func stop() -> String? {
        isRunning = false
        if let observer = configObserver {
            NotificationCenter.default.removeObserver(observer)
            configObserver = nil
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()

        do {
            return try wavWriter.flushPartial()
        } catch {
            return nil
        }
    }
}
