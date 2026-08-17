---
layout: default
lang: ru
title: Быстрый старт
description: Установите meet на macOS (Apple Silicon) и запишите первую встречу за пару минут.
---

# Быстрый старт

<p class="lead">Только macOS на Apple Silicon. Потребуются Homebrew, Xcode Command Line Tools и примерно 500 МБ под live-модель.</p>

## 1. Установите зависимости

```bash
brew install whisper-cpp ffmpeg
```

## 2. Склонируйте, соберите и подключите команду `meet`

```bash
git clone https://github.com/Dimasmagadan/meet.git
cd meet
npm install
npm run build
./native/AudioCapture/scripts/build.sh
npm link   # добавляет `meet` в PATH
```

## 3. Скачайте модель и проверьте setup

```bash
meet setup
# или: bash scripts/setup.sh
```

`setup` проверяет `whisper-cli`, live-модель, Swift-бинарь, разрешения и доступные на запись директории.

## 4. Запишите встречу

```bash
meet start "Еженедельный стендап"
```

Говорите в микрофон. Во время звонка:

| Клавиша | Действие |
|-----|--------|
| `q` | Стоп и финализация в фоне |
| `s` | Стоп и финализация в foreground |
| `n` | Завершить эту встречу и начать следующую |
| `p` | Пауза / возобновление |
| `e` | Продлить лимит на 15 минут |
| `a` | Спросить opencode о живом транскрипте |

## 5. Посмотрите результат

Встречи попадают в директории с тайм-кодом в имени:

```
~/Meetings/2026-05-13_14-30-weekly-standup/
├── transcript.md        # с метками спикеров и тайм-кодами
├── summary.md           # живой экстрактивный черновик
├── speakers.json        # диаризация + время речи
└── meta.md              # заголовок, дата, режим, теги, репо
```

## Дальнейшие шаги

- [Все возможности](../features/) — диаризация, оповещения внимания, фразеонимус, импорты.
- [README](https://github.com/Dimasmagadan/meet#readme) — полный справочник CLI и конфигурация.
- [CONTRIBUTING.md](https://github.com/Dimasmagadan/meet/blob/master/CONTRIBUTING.md) — сборка, тесты и конвенции PR.
