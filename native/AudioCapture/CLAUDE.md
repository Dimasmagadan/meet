# native/AudioCapture — Swift gotchas

## VoiceProcessing IO 9-Channel Bug

When you call `setVoiceProcessingEnabled(true)` on AVAudioEngine, Apple silently changes the output format to **9 channels**. This is undocumented and breaks most code.

**Solution**: Extract channel 0 manually from the PCM buffer:
```swift
let pcmBuffer = AVAudioPCMBuffer(...)
let floatData = pcmBuffer.floatChannelData![0]  // channel 0 only
```

**Do NOT use AVAudioConverter** — it crashes with 9-channel input. Resample manually with linear interpolation.

## Core Audio Process Tap (System Audio, macOS 14.2+)

`SystemAudioCapture.swift` captures system audio via a Core Audio process tap
instead of ScreenCaptureKit — this needs only "System Audio Recording Only"
TCC (`kTCCServiceAudioCapture`), not full Screen Recording, and has no
periodic re-approval nag. See `specs/SPEC_TCC_SCREEN_REPROMPT_2026-07-31.md` §6.

**`CATapDescription`'s convenience initializers have no Swift overlay** in
this SDK — they're all `NS_REFINED_FOR_SWIFT` with no accompanying friendly
overlay shipped, so Swift only exposes the `__`-prefixed selectors:
```swift
let desc = CATapDescription(__monoGlobalTapButExcludeProcesses: [NSNumber(value: ownProcessObjectID)])
```
Verified with `swiftc -typecheck` against the actual SDK headers
(`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/.../CATapDescription.h`)
— don't guess at friendlier names, the compiler will reject them.

**Aggregate device needs a real clock source.** A tap-only aggregate device
won't run; it must include the default system output device as a subdevice
(`kAudioAggregateDeviceSubDeviceListKey` + `kAudioAggregateDeviceMainSubDeviceKey`)
alongside the tap (`kAudioAggregateDeviceTapListKey`), even though only the
tap's audio is actually read in the IOProc.

**Resample from the tap's native rate to 16kHz** using the same manual
linear-interpolation pattern as `MicCapture.swift` (`AVAudioConverter` ban
in this file still applies — the tap delivers Float32 via `AudioBufferList`
in an `AudioDeviceIOProcIDWithBlock` callback, not an `AVAudioPCMBuffer`).

## WAV Header Finalization

After writing audio data, finalize the WAV header:
```swift
try wavWriter.finalize()  // updates byte counts in header
try FileManager.default.moveItem(atPath: tmpPath, toPath: finalPath)
```

Finalization must happen before the rename — the header includes file size.
