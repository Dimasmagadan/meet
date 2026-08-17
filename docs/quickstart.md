---
layout: default
title: Quick Start
description: Install meet on macOS (Apple Silicon) and record your first meeting in a few minutes.
---

# Quick Start

<p class="lead">macOS on Apple Silicon only. You'll need Homebrew, the Xcode Command Line Tools, and roughly 500 MB for the live model.</p>

## 1. Install dependencies

```bash
brew install whisper-cpp ffmpeg
```

## 2. Clone, build, and link the `meet` command

```bash
git clone https://github.com/Dimasmagadan/meet.git
cd meet
npm install
npm run build
./native/AudioCapture/scripts/build.sh
npm link   # puts `meet` on PATH
```

## 3. Download the model & verify setup

```bash
meet setup
# or: bash scripts/setup.sh
```

`setup` checks `whisper-cli`, the live model, the Swift binary, permissions, and writable directories.

## 4. Record a meeting

```bash
meet start "Weekly Standup"
```

Speak into your mic. During the call:

| Key | Action |
|-----|--------|
| `q` | Stop and finalize in the background |
| `s` | Stop and finalize in the foreground |
| `n` | Finish this meeting and start the next |
| `p` | Pause / resume |
| `e` | Extend the cap by 15 minutes |
| `a` | Ask opencode about the live transcript |

## 5. Read the result

Meetings land in timestamped subdirectories:

```
~/Meetings/2026-05-13_14-30-weekly-standup/
├── transcript.md        # speaker-labeled, timestamped
├── summary.md           # live extractive draft
├── speakers.json        # diarization + talk time
└── meta.md              # title, date, mode, tags, repo
```

## Next steps

- [All features](../features/) — diarization, attention alerts, phrasebook, imports.
- [README](https://github.com/Dimasmagadan/meet#readme) — full CLI reference and configuration.
- [CONTRIBUTING.md](https://github.com/Dimasmagadan/meet/blob/master/CONTRIBUTING.md) — build, test, and PR conventions.
