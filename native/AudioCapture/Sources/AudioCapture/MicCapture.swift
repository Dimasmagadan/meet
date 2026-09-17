import AVFoundation
import Dispatch

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
    private var paused = false
    // wavWriter is a mutating struct touched from the real-time audio-tap
    // callback (processBuffer) and from stop()/restart on the control thread.
    // All access is serialized through this queue instead of racing directly —
    // file I/O also no longer runs on the real-time thread.
    private let writerQueue = DispatchQueue(label: "miccapture.writer")
    // AVAudioEngine is documented as not thread-safe. Before this, three
    // threads could mutate the engine graph at once — the configuration-change
    // observer (registered with queue: nil, so it ran on the engine's own
    // background queue), the 1s stall monitor, and Ctrl-C stop() on the control
    // thread — with only a bare isRestarting flag between them. A Bluetooth
    // headset connect mid-meeting fires .AVAudioEngineConfigurationChange in a
    // burst and races restartCapture against stop()/recoverIfStalled: double
    // installTap, a tap torn down mid-flush, a corrupted engine graph. All
    // control-state mutation and engine access now funnels through this serial
    // queue, mirroring the writerQueue pattern already used for wavWriter.
    private let controlQueue = DispatchQueue(label: "miccapture.control")
    // Storage-error budget: a failed finalizeChunk leaves the writer closed and
    // every further append throws, while healthy audio callbacks keep refreshing
    // lastBufferTime — so the stall monitor can neither see nor fix this. Count
    // writer errors here, retry the chunk open a bounded number of times, and
    // then halt the stream visibly (writerFailed) instead of spinning forever.
    private var writerErrorCount = 0
    private let maxWriterRecoveryAttempts = 3
    private(set) var writerFailed = false

    // Phase-carrying resampler state (P0, SPEC_MIC_ECHO_FILTERING_2026-08-05
    // root cause B.3) — carried across buffers instead of restarting at 0
    // each call, which drops the fractional remainder every time.
    private var resampleSrcPos: Double = 0.0
    private var resamplePrevSample: Int16 = 0
    private var resampleHasPrev: Bool = false

    init(outputDir: URL, chunkDurationSeconds: Int, voiceProcessing: Bool = false, onChunkFinalized: @escaping (String) -> Void) {
        self.wavWriter = WAVWriter(outputDir: outputDir, prefix: "mic", chunkDurationSeconds: chunkDurationSeconds)
        self.voiceProcessing = voiceProcessing
        self.onChunkFinalized = onChunkFinalized
    }

    func start() throws {
        try writerQueue.sync {
            if !wavWriter.isChunkOpen {
                try wavWriter.startChunk()
            }
        }
        installConfigurationObserverIfNeeded()
        // startEngine touches the engine graph; run it on controlQueue so the
        // invariant "engine access only happens on controlQueue" holds from
        // boot, before the stall monitor or a configuration change can fire.
        try controlQueue.sync {
            try startEngine(reason: restartCount == 0 ? "initial" : "restart")
            isRunning = true
            lastBufferTime = Date()
        }
    }

    private func startEngine(reason: String) throws {
        let inputNode = engine.inputNode

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
        // queue: nil delivers the block on the engine's own background queue;
        // that's fine because the block does nothing but hop to controlQueue,
        // where the actual engine mutation (restartCapture) is serialized
        // against stop()/recoverIfStalled (B3). NotificationCenter's queue
        // parameter wants an OperationQueue, not a DispatchQueue, so the hop
        // is the lightweight way to get the serialization.
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            self?.controlQueue.async { self?.handleEngineConfigurationChange() }
        }
    }

    // Runs on controlQueue (see installConfigurationObserverIfNeeded), so it
    // can call restartCapture directly.
    private func handleEngineConfigurationChange() {
        guard isRunning else { return }
        fputs("MicCapture configuration changed; restarting tap\n", stderr)
        logJSON("warning", "mic_engine_config_changed", ["restart_count": restartCount])
        restartCapture(reason: "engine_config_changed")
    }

    // Precondition: called on controlQueue. Every caller now funnels through
    // it (configuration-change observer, recoverIfStalled), so the
    // isRestarting check-and-set is atomic w.r.t. the other engine mutators
    // instead of being a non-atomic cross-thread read.
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
        // restartCapture mutates the engine, so the stall check must run on
        // controlQueue; async keeps the 1s monitor loop from blocking on an
        // engine restart. The guard reads happen there too, so they can't race
        // a concurrent restart.
        controlQueue.async { [weak self] in
            guard let self, self.isRunning, !self.writerFailed else { return }
            let stalledFor = Date().timeIntervalSince(self.lastBufferTime)
            if stalledFor > thresholdSeconds {
                self.restartCapture(reason: "buffer_stall_\(Int(stalledFor))s")
            }
        }
    }

    func setPaused(_ value: Bool) {
        if paused && !value { lastVoiceTime = Date() }
        paused = value
    }

    private func processBuffer(_ buffer: AVAudioPCMBuffer, hwSampleRate: Float64, hwChannels: AVAudioChannelCount, isInterleaved: Bool, ratio: Double) {
        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else { return }
        lastBufferTime = Date()

        if paused { return }

        var monoSamples = [Int16]()

        if let floatData = buffer.floatChannelData {
            if isInterleaved && hwChannels > 1 {
                // Interleaved: floatData[0] is one flat stream of
                // frame*channel floats, so element j is channel (j % channels)
                // of frame (j / channels). Channel 0 of frame i lives at
                // i*channels — indexing [0][i] would return 1/channels of the
                // audio as garbage with no error. Dead today (VoiceProcessing
                // is non-interleaved, the 9-channel case is handled by
                // findLoudestChannel), but a device that reports interleaved
                // would silently produce noise.
                let stride = Int(hwChannels)
                monoSamples.reserveCapacity(frameLength)
                for i in 0..<frameLength {
                    let sample = floatData[0][i * stride]
                    let clamped = max(-1.0, min(1.0, sample))
                    monoSamples.append(Int16(clamped * 32767.0))
                }
            } else {
                let ch: Int
                if hwChannels <= 1 {
                    ch = 0
                } else {
                    ch = findLoudestChannel(floatData, channelCount: Int(hwChannels), frameLength: frameLength)
                }
                monoSamples.reserveCapacity(frameLength)
                for i in 0..<frameLength {
                    let sample = floatData[ch][i]
                    let clamped = max(-1.0, min(1.0, sample))
                    monoSamples.append(Int16(clamped * 32767.0))
                }
            }
        } else if let int16Data = buffer.int16ChannelData {
            if isInterleaved && hwChannels > 1 {
                let stride = Int(hwChannels)
                monoSamples.reserveCapacity(frameLength)
                for i in 0..<frameLength {
                    monoSamples.append(int16Data[0][i * stride])
                }
            } else {
                monoSamples.reserveCapacity(frameLength)
                for i in 0..<frameLength {
                    monoSamples.append(int16Data[0][i])
                }
            }
        }

        guard !monoSamples.isEmpty else { return }

        let rms: Double = sqrt(monoSamples.reduce(0.0) { $0 + Double($1) * Double($1) } / Double(monoSamples.count))
        if Float(rms) > voiceRmsThreshold {
            lastVoiceTime = Date()
        }

        let resampled = linearInterpolate(monoSamples, ratio: ratio)

        // File I/O and wavWriter mutation move off the real-time audio thread
        // and onto the serial writer queue, which also orders this against
        // stop()'s final flush instead of racing it directly.
        writerQueue.async { [weak self] in
            guard let self else { return }
            guard !self.writerFailed else { return }
            do {
                let chunkReady = try self.wavWriter.appendSamplesIfNeeded(resampled)
                if chunkReady {
                    if let name = try self.wavWriter.finalizeChunk() {
                        self.onChunkFinalized(name)
                    }
                    try self.wavWriter.startChunk()
                    // A clean finalize+reopen proves storage is healthy again,
                    // so the error budget is consecutive failures, not a
                    // lifetime total (B7: four isolated blips in a long meeting
                    // otherwise halted the stream permanently).
                    self.writerErrorCount = 0
                }
            } catch {
                self.writerErrorCount += 1
                fputs("MicCapture write error: \(error) (attempt \(self.writerErrorCount)/\(self.maxWriterRecoveryAttempts))\n", stderr)
                if self.writerErrorCount > self.maxWriterRecoveryAttempts {
                    self.writerFailed = true
                    self.wavWriter.abortCurrentChunk(preserveTemporary: true)
                    fputs("MicCapture storage failed permanently; halting mic stream, failed audio preserved\n", stderr)
                    logJSON("error", "stream_error", ["source": "mic", "message": "storage failure, stream halted"])
                    // Engine teardown from the writer queue would re-introduce
                    // the cross-thread engine access B3 fixes; hand it to
                    // controlQueue. isRunning flips first so any tap callback
                    // still in flight bails before touching the graph.
                    self.controlQueue.async {
                        self.isRunning = false
                        self.engine.inputNode.removeTap(onBus: 0)
                        self.engine.stop()
                    }
                    return
                }
                do {
                    self.wavWriter.abortCurrentChunk(preserveTemporary: true)
                    try self.wavWriter.startChunk()
                    let attempt = self.writerErrorCount
                    self.writerErrorCount = 0
                    logJSON("warning", "mic_writer_recovered", ["attempt": attempt])
                } catch {
                    fputs("MicCapture writer recovery failed: \(error)\n", stderr)
                }
            }
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

        var result = [Int16]()
        var srcPos = resampleSrcPos
        while true {
            let index = Int(srcPos.rounded(.down))
            let frac = srcPos - Double(index)
            let s0: Double
            let s1: Double
            if index == -1 {
                guard resampleHasPrev else { break }
                s0 = Double(resamplePrevSample)
                s1 = Double(samples[0])
            } else if index >= 0, index + 1 < samples.count {
                s0 = Double(samples[index])
                s1 = Double(samples[index + 1])
            } else {
                break
            }
            result.append(Int16(s0 + frac * (s1 - s0)))
            srcPos += ratio
        }

        resampleSrcPos = srcPos - Double(samples.count)
        resamplePrevSample = samples[samples.count - 1]
        resampleHasPrev = true
        return result
    }

    func stop() -> String? {
        // Engine teardown on controlQueue so it can't race a configuration-change
        // restart or a stall-monitor restart landing at the same instant (B3).
        // Sync, not async: the caller (Ctrl-C / sys-start failure) needs the
        // flush below to see the tap already gone.
        controlQueue.sync {
            isRunning = false
            if let observer = configObserver {
                NotificationCenter.default.removeObserver(observer)
                configObserver = nil
            }
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }

        // Synchronous dispatch onto the same serial queue drains any append/
        // finalize/startChunk block a still-in-flight tap callback already
        // enqueued before flushing, instead of racing it.
        return writerQueue.sync {
            do {
                return try wavWriter.flushPartial()
            } catch {
                return nil
            }
        }
    }
}
