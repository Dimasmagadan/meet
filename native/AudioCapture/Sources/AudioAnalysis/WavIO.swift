import Foundation

enum WavIOError: Error, CustomStringConvertible {
    case fileNotFound(String)
    case notRIFF
    case missingDataChunk
    case unsupportedFormat(String)

    var description: String {
        switch self {
        case .fileNotFound(let path): return "File not found: \(path)"
        case .notRIFF: return "Not a RIFF/WAVE file"
        case .missingDataChunk: return "WAV file has no data chunk"
        case .unsupportedFormat(let msg): return "Unsupported WAV format: \(msg)"
        }
    }
}

enum WavIO {
    /// Reads a 16kHz mono 16-bit PCM WAV file (our own AudioCapture output format)
    /// and returns samples as Float32 in [-1, 1]. Scans RIFF chunks rather than
    /// assuming a fixed 44-byte header so extra chunks don't break parsing.
    static func readMonoFloat32(path: String) throws -> [Float] {
        guard FileManager.default.fileExists(atPath: path) else {
            throw WavIOError.fileNotFound(path)
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        guard data.count >= 12,
            data[0..<4].elementsEqual("RIFF".utf8),
            data[8..<12].elementsEqual("WAVE".utf8)
        else {
            throw WavIOError.notRIFF
        }

        var offset = 12
        var channels = 1
        var bitsPerSample = 16
        var dataRange: Range<Int>?

        while offset + 8 <= data.count {
            let chunkId = data[offset..<(offset + 4)]
            let chunkSize = Int(readUInt32LE(data, offset + 4))
            let bodyStart = offset + 8
            let bodyEnd = min(bodyStart + chunkSize, data.count)

            if chunkId.elementsEqual("fmt ".utf8), bodyEnd - bodyStart >= 16 {
                channels = Int(readUInt16LE(data, bodyStart + 2))
                bitsPerSample = Int(readUInt16LE(data, bodyStart + 14))
            } else if chunkId.elementsEqual("data".utf8) {
                dataRange = bodyStart..<bodyEnd
            }

            offset = bodyEnd + (chunkSize % 2)
        }

        guard let range = dataRange else { throw WavIOError.missingDataChunk }
        guard bitsPerSample == 16 else {
            throw WavIOError.unsupportedFormat("expected 16-bit PCM, got \(bitsPerSample)-bit")
        }

        let sampleCount = (range.count / 2) / channels
        var samples = [Float]()
        samples.reserveCapacity(sampleCount)

        var pos = range.lowerBound
        for _ in 0..<sampleCount {
            let raw = Int16(bitPattern: readUInt16LE(data, pos))
            samples.append(Float(raw) / 32768.0)
            pos += 2 * channels  // channel 0 only when channels > 1 (shouldn't happen for our WAVs)
        }

        return samples
    }

    private static func readUInt16LE(_ data: Data, _ offset: Int) -> UInt16 {
        UInt16(data[offset]) | (UInt16(data[offset + 1]) << 8)
    }

    private static func readUInt32LE(_ data: Data, _ offset: Int) -> UInt32 {
        UInt32(data[offset]) | (UInt32(data[offset + 1]) << 8) | (UInt32(data[offset + 2]) << 16)
            | (UInt32(data[offset + 3]) << 24)
    }
}
