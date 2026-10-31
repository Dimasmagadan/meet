import Foundation

// Consecutive-failure budget for one WAV writer stream (P2-9,
// SPEC_SAFETY_NET_2026-10-31 §6.2). Extracted from the hand-rolled copies in
// MicCapture/SystemAudioCapture. The critical rule: only a SUCCESSFUL
// APPEND+FINALIZE resets the budget — creating a fresh 44-byte header
// (startChunk) proves only that file creation worked, not that data writes
// do. The old recovery path reset the counter right after startChunk, so a
// persistent data-write failure cycled "append fails → reopen header → count
// reset" forever: writerFailed never tripped, CaptureRunner's
// all-streams-halted check never fired, and the stream silently recorded
// nothing.
struct WriterErrorBudget {
    let maxConsecutiveFailures: Int
    private(set) var consecutiveFailures = 0

    init(maxConsecutiveFailures: Int) {
        self.maxConsecutiveFailures = maxConsecutiveFailures
    }

    // True once consecutive failures exceed the budget — the stream must halt
    // visibly instead of spinning (same strictly-greater threshold the inline
    // counters used).
    var tripped: Bool {
        consecutiveFailures > maxConsecutiveFailures
    }

    mutating func recordFailure() {
        consecutiveFailures += 1
    }

    /// Only a successful append+finalize cycle proves storage is healthy again
    /// (B7: consecutive failures, not a lifetime total — four isolated blips in
    /// a long meeting must not halt the stream permanently). NEVER call this
    /// from a startChunk() recovery path.
    mutating func recordSuccess() {
        consecutiveFailures = 0
    }
}

// assert()-based self-tests, run via `AudioCapture --self-test-writer`.
// AudioCapture has no XCTest on Command Line Tools, so this follows the
// MenuBar --self-test-* pattern (and test-swift.sh builds debug on purpose:
// release builds strip assert()).
enum WriterErrorBudgetSelfTest {
    static func run() {
        // Success resets the budget.
        var budget = WriterErrorBudget(maxConsecutiveFailures: 3)
        budget.recordFailure()
        budget.recordFailure()
        budget.recordSuccess()
        assert(budget.consecutiveFailures == 0)
        assert(!budget.tripped)

        // THE REGRESSION CASE (P2-9): a failure followed by header creation
        // (startChunk) must NOT reset — header creation is not evidence that
        // data writes work, so consecutive failures keep counting across
        // recovery attempts.
        budget.recordFailure()
        let countAtHeader = budget.consecutiveFailures
        // (simulated startChunk here — deliberately no recordSuccess())
        assert(budget.consecutiveFailures == countAtHeader, "startChunk must not reset the budget")
        budget.recordFailure()
        budget.recordFailure()
        budget.recordFailure()
        assert(budget.tripped, "4 consecutive failures must trip a budget of 3")

        // Threshold edge: exactly max consecutive failures does not trip.
        var edge = WriterErrorBudget(maxConsecutiveFailures: 3)
        edge.recordFailure()
        edge.recordFailure()
        edge.recordFailure()
        assert(!edge.tripped)
        edge.recordFailure()
        assert(edge.tripped)

        // A genuinely successful append after a trip clears it.
        edge.recordSuccess()
        assert(!edge.tripped)
        assert(edge.consecutiveFailures == 0)

        // P3 row 17: abortCurrentChunk must clear the carry — a stale carry
        // flushed into the next chunk would prepend misaligned tail audio.
        do {
            let dir = FileManager.default.temporaryDirectory
                .appendingPathComponent("meet-wavwriter-selftest-\(Int.random(in: 0...1_000_000))", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: dir) }
            var writer = WAVWriter(outputDir: dir, prefix: "mic", chunkDurationSeconds: 1)
            try writer.startChunk()
            // 1s chunk = 16000 samples; overshoot by 10 → carry holds 10.
            let overshoot = [Int16](repeating: 100, count: 16010)
            let boundaryReached = try writer.appendSamplesIfNeeded(overshoot)
            assert(boundaryReached, "chunk boundary reached")
            writer.abortCurrentChunk(preserveTemporary: false)
            try writer.startChunk()
            try writer.appendSamples([7, 7])
            let name = try writer.finalizeChunk()
            assert(name != nil, "chunk finalized")
            // 44-byte header + exactly the 2 post-abort samples: a stale carry
            // would have flushed 10 more.
            let size = try FileManager.default.attributesOfItem(
                atPath: dir.appendingPathComponent("mic-001.wav").path
            )[.size] as? Int
            assert(size == 44 + 4, "carry must be cleared on abort — got \(size ?? -1) bytes")
        } catch {
            assertionFailure("carry-clear case failed: \(error)")
        }

        print("writer self-test OK")
    }
}
