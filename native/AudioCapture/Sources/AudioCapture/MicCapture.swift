import AVFoundation

@available(macOS 14.0, *)
class MicCapture {
    private let engine = AVAudioEngine()
    private var wavWriter: WAVWriter
    private let targetSampleRate: Int = 16000
    private var isRunning = false
    private let onChunkFinalized: (String) -> Void

    init(outputDir: URL, chunkDurationSeconds: Int, onChunkFinalized: @escaping (String) -> Void) {
        self.wavWriter = WAVWriter(outputDir: outputDir, prefix: "mic", chunkDurationSeconds: chunkDurationSeconds)
        self.onChunkFinalized = onChunkFinalized
    }

    func start() throws {
        let inputNode = engine.inputNode
        let hardwareFormat = inputNode.outputFormat(forBus: 0)

        try inputNode.setVoiceProcessingEnabled(true)

        inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(
            enableAdvancedDucking: false,
            duckingLevel: .min
        )

        let hwSampleRate = hardwareFormat.sampleRate
        let hwChannels = hardwareFormat.channelCount
        let ratio = Double(hwSampleRate) / Double(targetSampleRate)

        try wavWriter.startChunk()
        isRunning = true

        inputNode.installTap(onBus: 0, bufferSize: 4096, format: hardwareFormat) { [weak self] buffer, _ in
            guard let self, self.isRunning else { return }
            self.processBuffer(buffer, hwSampleRate: hwSampleRate, hwChannels: hwChannels, ratio: ratio)
        }

        try engine.start()
    }

    private func processBuffer(_ buffer: AVAudioPCMBuffer, hwSampleRate: Float64, hwChannels: AVAudioChannelCount, ratio: Double) {
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return }

        var monoSamples = [Int16]()

        if let channelData = buffer.floatChannelData?[0] {
            for i in 0..<frameLength {
                let sample = channelData[i]
                let clamped = max(-1.0, min(1.0, sample))
                monoSamples.append(Int16(clamped * 32767.0))
            }
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

    private func linearInterpolate(_ samples: [Int16], ratio: Double) -> [Int16] {
        guard ratio > 0, !samples.isEmpty else { return samples }
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
