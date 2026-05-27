import AVFoundation

@available(macOS 14.0, *)
class MicCapture {
    private let engine = AVAudioEngine()
    private var wavWriter: WAVWriter
    private let targetSampleRate: Int = 16000
    private let voiceProcessing: Bool
    private var isRunning = false
    private let onChunkFinalized: (String) -> Void
    private var formatLogged = false
    private(set) var lastVoiceTime: Date = Date()
    private let voiceRmsThreshold: Float = 200.0

    init(outputDir: URL, chunkDurationSeconds: Int, voiceProcessing: Bool = false, onChunkFinalized: @escaping (String) -> Void) {
        self.wavWriter = WAVWriter(outputDir: outputDir, prefix: "mic", chunkDurationSeconds: chunkDurationSeconds)
        self.voiceProcessing = voiceProcessing
        self.onChunkFinalized = onChunkFinalized
    }

    func start() throws {
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

        try wavWriter.startChunk()
        isRunning = true

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: vpFormat) { [weak self] buffer, _ in
            guard let self, self.isRunning else { return }
            self.processBuffer(buffer, hwSampleRate: hwSampleRate, hwChannels: hwChannels, isInterleaved: hwIsInterleaved, ratio: ratio)
        }

        try engine.start()
    }

    private func processBuffer(_ buffer: AVAudioPCMBuffer, hwSampleRate: Float64, hwChannels: AVAudioChannelCount, isInterleaved: Bool, ratio: Double) {
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return }

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
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()

        do {
            return try wavWriter.flushPartial()
        } catch {
            return nil
        }
    }
}
