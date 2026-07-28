# native/AudioCapture — Swift gotchas

## VoiceProcessing IO 9-Channel Bug

When you call `setVoiceProcessingEnabled(true)` on AVAudioEngine, Apple silently changes the output format to **9 channels**. This is undocumented and breaks most code.

**Solution**: Extract channel 0 manually from the PCM buffer:
```swift
let pcmBuffer = AVAudioPCMBuffer(...)
let floatData = pcmBuffer.floatChannelData![0]  // channel 0 only
```

**Do NOT use AVAudioConverter** — it crashes with 9-channel input. Resample manually with linear interpolation.

## ScreenCaptureKit Requires Video Config

Even for audio-only capture, you must provide minimal video config:
```swift
config.width = 2
config.height = 2
```

## WAV Header Finalization

After writing audio data, finalize the WAV header:
```swift
try wavWriter.finalize()  // updates byte counts in header
try FileManager.default.moveItem(atPath: tmpPath, toPath: finalPath)
```

Finalization must happen before the rename — the header includes file size.
