import Foundation

struct WAVWriter {
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

    init(outputDir: URL, prefix: String, chunkDurationSeconds: Int) {
        self.outputDir = outputDir
        self.prefix = prefix
        self.maxChunkSamples = sampleRate * channels * chunkDurationSeconds
    }

    var isChunkOpen: Bool { currentFileHandle != nil }

    func chunkFilename(_ index: Int) -> String {
        String(format: "\(prefix)-%03d.wav", index)
    }

    mutating func startChunk() throws {
        guard currentFileHandle == nil else { return }

        let tmpName = chunkFilename(chunkIndex) + ".tmp"
        let tmpPath = outputDir.appendingPathComponent(tmpName)

        currentTmpPath = tmpPath
        currentDataSize = 0

        let header = WAVWriter.makeHeader(dataSize: 0, sampleRate: sampleRate, channels: channels, bitsPerSample: bitsPerSample)
        FileManager.default.createFile(atPath: tmpPath.path, contents: header)
        currentFileHandle = try FileHandle(forWritingTo: tmpPath)
    }

    mutating func appendSamples(_ samples: [Int16]) throws {
        guard let handle = currentFileHandle else { return }

        var data = Data(capacity: samples.count * 2)
        for s in samples {
            var val = s.littleEndian
            data.append(Data(bytes: &val, count: 2))
        }
        try handle.write(contentsOf: data)
        currentDataSize += data.count
    }

    mutating func appendSamplesIfNeeded(_ samples: [Int16]) throws -> Bool {
        guard currentDataSize / 2 < maxChunkSamples else { return false }
        try appendSamples(samples)
        return currentDataSize / 2 >= maxChunkSamples
    }

    @discardableResult
    mutating func finalizeChunk() throws -> String? {
        guard let handle = currentFileHandle,
              let tmpPath = currentTmpPath else { return nil }

        let header = WAVWriter.makeHeader(dataSize: UInt32(currentDataSize), sampleRate: sampleRate, channels: channels, bitsPerSample: bitsPerSample)
        try handle.seek(toOffset: 0)
        try handle.write(contentsOf: header)
        try handle.close()

        let finalName = chunkFilename(chunkIndex)
        let finalPath = outputDir.appendingPathComponent(finalName)

        _ = try? FileManager.default.removeItem(at: finalPath)
        try FileManager.default.moveItem(at: tmpPath, to: finalPath)

        currentFileHandle = nil
        currentTmpPath = nil
        let result = finalName
        chunkIndex += 1
        currentDataSize = 0
        return result
    }

    mutating func flushPartial() throws -> String? {
        if currentDataSize > 0 {
            return try finalizeChunk()
        }
        if let tmpPath = currentTmpPath {
            try? FileManager.default.removeItem(at: tmpPath)
        }
        currentFileHandle = nil
        currentTmpPath = nil
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
