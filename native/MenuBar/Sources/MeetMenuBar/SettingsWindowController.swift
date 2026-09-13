import Cocoa

// Curated settings window: the ~8-10 options people actually flip (speaker
// recognition, diarization, alerts, language...) out of the ~50 keys in
// config.json. Everything else stays a JSON edit via "Open Config File…".
final class SettingsWindowController: NSWindowController {
    private let voiceProcessingCheckbox = NSButton(checkboxWithTitle: "Mic Echo Cancellation (AEC)", target: nil, action: nil)
    private let diarizationCheckbox = NSButton(checkboxWithTitle: "Speaker Diarization", target: nil, action: nil)
    private let speakerRegistryCheckbox = NSButton(checkboxWithTitle: "Speaker Recognition (cross-session voice registry)", target: nil, action: nil)
    private let attentionCheckbox = NSButton(checkboxWithTitle: "Attention Alerts (trigger words)", target: nil, action: nil)
    private let summaryCheckbox = NSButton(checkboxWithTitle: "Live Meeting Summary", target: nil, action: nil)
    private let parakeetCheckbox = NSButton(checkboxWithTitle: "Parakeet A/B Compare Pass", target: nil, action: nil)
    private let lowerPriorityCheckbox = NSButton(checkboxWithTitle: "Lower Transcription Process Priority", target: nil, action: nil)
    private let languageField = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 24))
    private let chunkDurationField = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 24))
    private let matchThresholdField = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 24))
    private let liveModelPopup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 220, height: 26))
    private let finalModelPopup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 220, height: 26))

    private var config: [String: Any] = [:]

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 620),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Meet Settings"
        window.isReleasedWhenClosed = false
        self.init(window: window)
        // NSWindowController only calls windowDidLoad() for nib-backed windows —
        // this window is built programmatically, so build the UI here instead.
        buildUI()
    }

    func show() {
        loadIntoFields()
        window?.center()
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    // MARK: - Data

    private func loadIntoFields() {
        config = ConfigStore.load()
        voiceProcessingCheckbox.state = ConfigStore.bool(config, "micVoiceProcessing", default: false) ? .on : .off
        diarizationCheckbox.state = ConfigStore.bool(config, "diarizationEnabled", default: true) ? .on : .off
        speakerRegistryCheckbox.state = ConfigStore.bool(config, "speakerRegistryEnabled", default: false) ? .on : .off
        attentionCheckbox.state = ConfigStore.bool(config, "attentionAlerts", default: true) ? .on : .off
        summaryCheckbox.state = ConfigStore.bool(config, "summaryEnabled", default: true) ? .on : .off
        parakeetCheckbox.state = ConfigStore.bool(config, "parakeetComparePass", default: true) ? .on : .off
        lowerPriorityCheckbox.state = ConfigStore.bool(config, "lowerProcessPriority", default: true) ? .on : .off
        languageField.stringValue = ConfigStore.string(config, "language", default: "ru")
        chunkDurationField.stringValue = String(ConfigStore.int(config, "chunkDurationSeconds", default: 30))
        matchThresholdField.stringValue = String(ConfigStore.double(config, "speakerMatchThreshold", default: 0.75))
        fillModelPopup(liveModelPopup, key: "liveModelPath", fallback: "~/.meet/models/ggml-small.bin")
        fillModelPopup(finalModelPopup, key: "finalModelPath", fallback: "~/.meet/models/ggml-large-v3-turbo-q5_0.bin")
    }

    @objc private func save() {
        config["micVoiceProcessing"] = voiceProcessingCheckbox.state == .on
        config["diarizationEnabled"] = diarizationCheckbox.state == .on
        config["speakerRegistryEnabled"] = speakerRegistryCheckbox.state == .on
        config["attentionAlerts"] = attentionCheckbox.state == .on
        config["summaryEnabled"] = summaryCheckbox.state == .on
        config["parakeetComparePass"] = parakeetCheckbox.state == .on
        config["lowerProcessPriority"] = lowerPriorityCheckbox.state == .on
        config["language"] = languageField.stringValue
        if let n = Int(chunkDurationField.stringValue), n > 0 { config["chunkDurationSeconds"] = n }
        if let d = Double(matchThresholdField.stringValue), (0...1).contains(d) { config["speakerMatchThreshold"] = d }
        // representedObject carries the tilde-contracted path written back to
        // config (nil on the "(no models found)" placeholder → key untouched).
        if let live = liveModelPopup.selectedItem?.representedObject as? String {
            config["liveModelPath"] = live
        }
        if let finalPath = finalModelPopup.selectedItem?.representedObject as? String {
            config["finalModelPath"] = finalPath
        }

        do {
            try ConfigStore.save(config)
            window?.close()
        } catch {
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "Could not save settings"
            alert.informativeText = error.localizedDescription
            alert.runModal()
        }
    }

    @objc private func cancel() {
        window?.close()
    }

    @objc private func openConfigFile() {
        NSWorkspace.shared.open(URL(fileURLWithPath: ConfigStore.path))
    }

    // MARK: - Layout

    private func buildUI() {
        guard let contentView = window?.contentView else { return }

        let openConfigButton = NSButton(title: "Open Config File…", target: self, action: #selector(openConfigFile))
        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancelButton.keyEquivalent = "\u{1b}"
        let saveButton = NSButton(title: "Save", target: self, action: #selector(save))
        saveButton.keyEquivalent = "\r"

        let actionRow = NSStackView(views: [cancelButton, saveButton])
        actionRow.orientation = .horizontal
        actionRow.spacing = 8

        let mainStack = NSStackView(views: [
            sectionLabel("Recording"),
            labeledRow("Language (whisper -l):", languageField),
            hint("Код языка распознавания речи (ru, en, ...)."),
            labeledRow("Chunk Duration (seconds):", chunkDurationField),
            hint("Длина чанка записи. Whisper всегда прогоняет полный 30-секундный энкодер: чанк короче 30с платит эту цену дважды. 30с — минимум вычислений и лучший контекст, живой текст отстаёт до 30с."),
            labeledRow("Live Model:", liveModelPopup),
            labeledRow("Final Model:", finalModelPopup),
            hint("Live — применяется со следующего чанка (~30 с), можно менять прямо во время звонка: turbo точнее, small легче для машины под нагрузкой. Final — модель финального прохода после встречи; уже идущий проход не переключается."),
            withHint(voiceProcessingCheckbox, "Выкл. по умолчанию: конфликтует с AEC/AGC самого приложения звонка на том же микрофоне — собеседникам становится еле слышно тебя в реальном звонке (не только в записи). Уменьшает эхо в транскрипте («Me» вместо чужих реплик), но включай только если проверил, что громкость для собеседников не проседает."),
            separator(),
            sectionLabel("Speakers"),
            withHint(diarizationCheckbox, "Различать голоса в системном аудио и подписывать их Speaker 1/2/... Выключи, если митинг всегда 1-на-1 и разбивка по спикерам не нужна."),
            withHint(speakerRegistryCheckbox, "Запоминать голоса между встречами, чтобы через время подставлять реальные имена вместо Speaker N. Включай, если регулярно встречаешься с одними и теми же людьми."),
            labeledRow("Speaker Match Threshold (0–1):", matchThresholdField),
            hint("Порог схожести голоса для автоподстановки имени из реестра. Выше — надёжнее совпадение, но чаще остаётся Speaker N."),
            separator(),
            sectionLabel("Alerts & Passes"),
            withHint(attentionCheckbox, "Уведомление, когда в разговоре звучит слово из triggers.json (например, твоё имя) — не пропустить обращение, если отвлёкся."),
            withHint(summaryCheckbox, "Живое саммари по ходу встречи в терминале/панели. Выключи, если отвлекает или встреча короткая."),
            withHint(parakeetCheckbox, "Доп. прогон другой моделью (Parakeet) для сравнения качества транскрипции — удлиняет финализацию, полезно только при отладке качества."),
            withHint(lowerPriorityCheckbox, "Понижает приоритет процесса транскрипции (taskpolicy), чтобы запись звука не проседала под нагрузкой. Оставляй включённым, выключай только для замера скорости распознавания."),
            separator(),
            openConfigButton,
            actionRow,
        ])
        mainStack.orientation = .vertical
        mainStack.alignment = .leading
        mainStack.spacing = 12
        mainStack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        mainStack.translatesAutoresizingMaskIntoConstraints = false

        // Hints make the content taller than any fixed window size can
        // guarantee (wrapping labels, localization, font size) — scroll
        // rather than clip or guess a magic height.
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = mainStack

        contentView.addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: contentView.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            mainStack.topAnchor.constraint(equalTo: scrollView.topAnchor),
            mainStack.leadingAnchor.constraint(equalTo: scrollView.leadingAnchor),
            mainStack.trailingAnchor.constraint(equalTo: scrollView.trailingAnchor),
            mainStack.widthAnchor.constraint(equalTo: scrollView.widthAnchor),
        ])
    }

    private func sectionLabel(_ title: String) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .boldSystemFont(ofSize: 13)
        return label
    }

    private func labeledRow(_ title: String, _ field: NSView) -> NSStackView {
        let label = NSTextField(labelWithString: title)
        let row = NSStackView(views: [label, field])
        row.orientation = .horizontal
        row.spacing = 8
        return row
    }

    // Small gray caption under a checkbox/field, wrapped to the window width —
    // the mini "when to enable/disable" instructions the settings window
    // doesn't otherwise have room for.
    private func hint(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = .systemFont(ofSize: 11)
        label.textColor = .secondaryLabelColor
        label.preferredMaxLayoutWidth = 380
        return label
    }

    private func withHint(_ checkbox: NSButton, _ text: String) -> NSStackView {
        let stack = NSStackView(views: [checkbox, hint(text)])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        return stack
    }

    private func separator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        box.widthAnchor.constraint(equalToConstant: 380).isActive = true
        return box
    }

    // MARK: - Model switcher

    private func listModelFiles() -> [String] {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".meet/models")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        return names
            .filter { $0.hasSuffix(".bin") }
            .sorted()
            .map { dir.appendingPathComponent($0).path }
    }

    // Display-only twin of modelAlias() in src/model-select.ts — the file path
    // written to config is the source of truth, the alias is just the label.
    private func modelAlias(_ filename: String) -> String {
        let lower = filename.lowercased()
        if lower.contains("turbo") { return "turbo" }
        if lower.contains("large") { return "large" }
        if lower.contains("medium") { return "medium" }
        if lower.contains("small") { return "small" }
        if lower.contains("tiny") { return "tiny" }
        return (lower as NSString).lastPathComponent
            .replacingOccurrences(of: ".bin", with: "")
            .replacingOccurrences(of: "ggml-", with: "")
    }

    private func sizeMb(_ path: String) -> Int {
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        return Int((attrs?[.size] as? NSNumber)?.intValue ?? 0) / (1024 * 1024)
    }

    private func fillModelPopup(_ popup: NSPopUpButton, key: String, fallback: String) {
        popup.removeAllItems()
        let currentRaw = ConfigStore.string(config, key, default: fallback)
        let current = (currentRaw as NSString).expandingTildeInPath

        var matched = false
        for path in listModelFiles() {
            let name = (path as NSString).lastPathComponent
            popup.addItem(withTitle: "\(modelAlias(name)) — \(sizeMb(path))M")
            guard let item = popup.lastItem else { continue }
            item.representedObject = (path as NSString).abbreviatingWithTildeInPath
            item.toolTip = name
            if path == current {
                popup.select(item)
                matched = true
            }
        }
        if !matched {
            // Current path points outside the models dir (or the file was
            // deleted): show it so Save doesn't silently change the model.
            popup.addItem(withTitle: "custom — \((currentRaw as NSString).lastPathComponent)")
            if let item = popup.lastItem {
                item.representedObject = currentRaw
                item.toolTip = currentRaw
                popup.select(item)
            }
        }
    }
}
