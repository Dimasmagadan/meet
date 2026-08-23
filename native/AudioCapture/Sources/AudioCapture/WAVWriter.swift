import Foundation

struct WAVWriter {
    private enum State { case idle, writing, failed }
    enum WriterError: Error { case chunkAlreadyOpen, noOpenChunk, destinationExists }
    private let outputDir: URL
    private let sampleRate: Int = 16000
    private let channels: Int = 1
    private let bitsPerSample: Int = 16
    private let prefix: String
    private(set) var chunkIndex: Int = 1

    private var currentFileHandle: FileHandle?
    private var currentTmpPath: URL?
    private var currentDataSize: Int = 0
    private let maxChunkSamples: Int
    // Carries the overshoot past maxChunkSamples from one chunk into the next,
    // so mic/sys chunks land on exact wall-clock boundaries instead of each
    // accumulating its own per-buffer overshoot at a different rate (P0,
    // SPEC_MIC_ECHO_FILTERING_2026-08-05 root cause B.2).
    private var carry: [Int16] = []
    private var state: State = .idle

    init(outputDir: URL, prefix: String, chunkDurationSeconds: Int) {
        self.outputDir = outputDir
        self.prefix = prefix
        self.maxChunkSamples = sampleRate * channels * chunkDurationSeconds
    }

    var isChunkOpen: Bool { state == .writing && currentFileHandle != nil }

    func chunkFilename(_ index: Int) -> String {
        String(format: "\(prefix)-%03d.wav", index)
    }

    mutating func startChunk() throws {
        guard state != .writing else { throw WriterError.chunkAlreadyOpen }

        let tmpName = chunkFilename(chunkIndex) + ".tmp"
        let tmpPath = outputDir.appendingPathComponent(tmpName)

        let header = WAVWriter.makeHeader(dataSize: 0, sampleRate: sampleRate, channels: channels, bitsPerSample: bitsPerSample)
        guard FileManager.default.createFile(atPath: tmpPath.path, contents: header) else { throw CocoaError(.fileWriteUnknown) }
        do {
            let handle = try FileHandle(forWritingTo: tmpPath)
            try handle.seekToEnd()
            currentTmpPath = tmpPath
            currentFileHandle = handle
            currentDataSize = 0
            state = .writing
        } catch {
            abortCurrentChunk(preserveTemporary: false)
            throw error
        }

        if !carry.isEmpty {
            let toFlush = carry
            carry = []
            try appendSamples(toFlush)
        }
    }

    mutating func appendSamples(_ samples: [Int16]) throws {
        guard state == .writing, let handle = currentFileHandle else { throw WriterError.noOpenChunk }

        var data = Data(capacity: samples.count * 2)
        for s in samples {
            var val = s.littleEndian
            data.append(Data(bytes: &val, count: 2))
        }
        try handle.write(contentsOf: data)
        currentDataSize += data.count
    }

    mutating func appendSamplesIfNeeded(_ samples: [Int16]) throws -> Bool {
        guard state == .writing else { throw WriterError.noOpenChunk }
        guard currentDataSize / 2 < maxChunkSamples else { return false }

        let remaining = maxChunkSamples - currentDataSize / 2
        if samples.count > remaining {
            // Split exactly at the chunk boundary: write the head, carry the
            // tail into the next chunk instead of letting this chunk overshoot.
            let head = Array(samples[0..<remaining])
            let tail = Array(samples[remaining...])
            try appendSamples(head)
            carry = tail
            return true
        }

        try appendSamples(samples)
        return currentDataSize / 2 >= maxChunkSamples
    }

    @discardableResult
    mutating func finalizeChunk() throws -> String? {
        guard state == .writing, let handle = currentFileHandle, let tmpPath = currentTmpPath else { return nil }
        let finalName = chunkFilename(chunkIndex)
        let finalPath = outputDir.appendingPathComponent(finalName)
        guard !FileManager.default.fileExists(atPath: finalPath.path) else { throw WriterError.destinationExists }
        do {
            let header = WAVWriter.makeHeader(dataSize: UInt32(currentDataSize), sampleRate: sampleRate, channels: channels, bitsPerSample: bitsPerSample)
            try handle.seek(toOffset: 0)
            try handle.write(contentsOf: header)
            try handle.close()
            currentFileHandle = nil
            try FileManager.default.moveItem(at: tmpPath, to: finalPath)
            currentTmpPath = nil
            state = .idle
            let result = finalName
            chunkIndex += 1
            currentDataSize = 0
            return result
        } catch {
            abortCurrentChunk(preserveTemporary: true)
            throw error
        }
    }

    mutating func abortCurrentChunk(preserveTemporary: Bool) {
        try? currentFileHandle?.close()
        currentFileHandle = nil
        if let tmpPath = currentTmpPath {
            if preserveTemporary {
                let diagnostic = tmpPath.deletingPathExtension().appendingPathExtension("failed.wav.tmp")
                try? FileManager.default.moveItem(at: tmpPath, to: diagnostic)
            } else {
                try? FileManager.default.removeItem(at: tmpPath)
            }
        }
        currentTmpPath = nil
        currentDataSize = 0
        state = .failed
    }

    mutating func flushPartial() throws -> String? {
        if currentDataSize > 0 {
            return try finalizeChunk()
        }
        abortCurrentChunk(preserveTemporary: false)
        return nil
    }

    static func makeHeader(dataSize: UInt32, sampleRate: Int, channels: Int, bitsPerSample: Int) -> Data {
        let byteRate = UInt32(sampleRate) * UInt32(channels) * UInt32(bitsPerSample) / 8
        let blockAlign = UInt16(channels) * UInt16(bitsPerSample) / 8
        let fileSize = 36 + dataSize

        var header = Data()
        header.append(contentsOf: [UInt8]("RIFF".utf8))
        header.append(contentsOf: withUnsafeBytes(of: fileSize.littleEndian) { Array($0) })
        header.append(contentsOf: [UInt8]("WAVE".utf8))
        header.append(contentsOf: [UInt8]("fmt ".utf8))
        header.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(channels).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate).littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: byteRate.littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: blockAlign.littleEndian) { Array($0) })
        header.append(contentsOf: withUnsafeBytes(of: UInt16(bitsPerSample).littleEndian) { Array($0) })
        header.append(contentsOf: [UInt8]("data".utf8))
        header.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })
        return header
    }
}
