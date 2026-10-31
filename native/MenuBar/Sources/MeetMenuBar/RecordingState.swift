import Foundation

// Pure decisions about CLI-started recording sessions (P2-8,
// SPEC_SAFETY_NET_2026-10-31 §6.1) — no AppKit/EventKit imports, in the
// CalendarMatch.swift style so it is directly unit-testable via
// `MeetMenuBar --self-test-recording`.
//
// An ATTACHED session (started by the CLI, adopted via the lock file) has no
// Process to observe: a SIGKILLed node — or a closed terminal, which sends no
// SIGHUP a headless recorder handles — leaves active-recording.lock on disk.
// The UI then counts forever, Stop signals a dead PID, and manual Start is
// refused by `guard state == .idle` until relaunch. The lock's pid is the
// only liveness evidence.
enum RecordingStatePure {
    /// - lockExists: the active-recording.lock file is present.
    /// - pidAlive: `kill(attachedPid, 0) == 0`.
    /// Returns true when the attached session must be terminated and its
    /// stale lock cleared. A missing lock is NOT "dead" — the CLI cleaned up
    /// after itself, which RecordingController handles as its idle path.
    static func isAttachedSessionDead(lockExists: Bool, pidAlive: Bool) -> Bool {
        guard lockExists else { return false }
        return !pidAlive
    }

    static func selfCheck() {
        // Alive attached session → keep counting.
        assert(isAttachedSessionDead(lockExists: true, pidAlive: true) == false)
        // Dead PID under a live lock → terminate + clear the stale lock.
        assert(isAttachedSessionDead(lockExists: true, pidAlive: false) == true)
        // Lock gone → the existing idle branch handles it, not the dead check.
        assert(isAttachedSessionDead(lockExists: false, pidAlive: false) == false)
        assert(isAttachedSessionDead(lockExists: false, pidAlive: true) == false)
        // ActiveLock.isPidAlive smoke: our own pid is alive; one beyond the
        // kernel's pid range is not.
        assert(ActiveLock.isPidAlive(getpid()))
        assert(!ActiveLock.isPidAlive(999_999_999))
        print("recording self-test OK")
    }
}
