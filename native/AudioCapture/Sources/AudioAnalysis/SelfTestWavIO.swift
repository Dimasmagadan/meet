import ArgumentParser
import Foundation

// P3 row 21 (SPEC_SAFETY_NET_2026-10-31 §7): assert()-based checks on WavIO's
// fmt handling — a synthetic 48 kHz file and a non-PCM format tag must be
// rejected explicitly instead of silently mis-timed. Command Line Tools ship
// no XCTest, so this follows the --self-test-* flag pattern; run via
// `AudioAnalysis self-test-wavio`.
struct SelfTestWavIO: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "self-test-wavio",
        abstract: "Run WavIO fmt self-tests (debug builds only — release strips assert)"
    )

    static func makeWav(sampleRate: UInt32, formatTag: UInt16) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("meet-wavio-selftest-\(sampleRate)-\(formatTag)-\(Int.random(in: 0...1_000_000)).wav")
        var header = Data()
        let dataSize: UInt32 = 8
        header.append(contentsOf: Array("RIFF".utf8))
        withUnsafeBytes(of: (36 + dataSize).littleEndian) { header.append(contentsOf: $0) }
        header.append(contentsOf: Array("WAVE".utf8))
        header.append(contentsOf: Array("fmt ".utf8))
        withUnsafeBytes(of: UInt32(16).littleEndian) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: formatTag.littleEndian) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: UInt16(1).littleEndian) { header.append(contentsOf: $0) }  // channels
        withUnsafeBytes(of: sampleRate.littleEndian) { header.append(contentsOf: $0) }
        withUnsafeBytes(of: (sampleRate * 2).littleEndian) { header.append(contentsOf: $0) }  // byte rate
        withUnsafeBytes(of: UInt16(2).littleEndian) { header.append(contentsOf: $0) }  // block align
        withUnsafeBytes(of: UInt16(16).littleEndian) { header.append(contentsOf: $0) }  // bits
        header.append(contentsOf: Array("data".utf8))
        withUnsafeBytes(of: dataSize.littleEndian) { header.append(contentsOf: $0) }
        header.append(contentsOf: [0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x04])
        try header.write(to: url)
        return url
    }

    func run() throws {
        // 16 kHz PCM reads fine.
        let ok16 = try Self.makeWav(sampleRate: 16000, formatTag: 1)
        let samples = try WavIO.readMonoFloat32(path: ok16.path)
        assert(samples.count == 4, "expected 4 samples, got \(samples.count)")
        try? FileManager.default.removeItem(at: ok16)

        // THE REGRESSION CASE: a 48 kHz file must be rejected explicitly — the
        // old reader ignored the fmt sample rate and silently mis-timed audio.
        let bad48 = try Self.makeWav(sampleRate: 48000, formatTag: 1)
        do {
            _ = try WavIO.readMonoFloat32(path: bad48.path)
            assertionFailure("48 kHz WAV must be rejected")
        } catch let error as WavIOError {
            assert(String(describing: error).contains("16 kHz"), "unexpected error: \(error)")
        }
        try? FileManager.default.removeItem(at: bad48)

        // Non-PCM (e.g. float) format tag rejected.
        let floatFmt = try Self.makeWav(sampleRate: 16000, formatTag: 3)
        do {
            _ = try WavIO.readMonoFloat32(path: floatFmt.path)
            assertionFailure("non-PCM format tag must be rejected")
        } catch let error as WavIOError {
            assert(String(describing: error).contains("PCM"), "unexpected error: \(error)")
        }
        try? FileManager.default.removeItem(at: floatFmt)

        print("wavio self-test OK")
    }
}
