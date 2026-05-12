---
name: swift-audio
description: Reference for AVAudioEngine mic capture and ScreenCaptureKit audio capture pitfalls on macOS Apple Silicon
license: MIT
compatibility: opencode
---

## AVAudioEngine + VoiceProcessing IO

- `setVoiceProcessingEnabled(true)` for echo cancellation (critical without headphones)
- VoiceProcessing silently changes output to **9 channels** (undocumented by Apple)
- Do NOT use AVAudioConverter — crashes with 9-channel input
- Extract channel 0 manually from PCM buffer
- Resample to 16kHz with linear interpolation
- System audio ducking fix: `inputNode.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)`

## ScreenCaptureKit Audio-Only Capture

```swift
config.capturesAudio = true
config.excludesCurrentProcessAudio = true   // prevent feedback loops
config.sampleRate = 16_000
config.channelCount = 1
// Minimal video required but unused:
config.width = 2
config.height = 2
```

- Use `SCStreamOutput` protocol, process `CMSampleBuffer` with audio type
- Convert `CMSampleBuffer` → PCM → 16-bit WAV manually
- Requires Screen Recording permission (System Settings → Privacy)

## WAV Output Format

- 16kHz mono 16-bit PCM
- 44-byte WAV header
- File naming: `mic-001.wav`, `sys-001.wav` (zero-padded 3 digits)
- SIGINT handler: flush current buffer as final chunk, then exit cleanly

## Build

```bash
cd native/AudioCapture && swift build -c release
# Output: .build/release/AudioCapture
```

## CLI Interface

```
AudioCapture --output-dir /tmp/meet-abc123 --chunk-duration 30 --mode full
AudioCapture --output-dir /tmp/meet-abc123 --chunk-duration 30 --mode mic
```

## Key Imports

```swift
import AVFoundation
import ScreenCaptureKit
import ArgumentParser
```
