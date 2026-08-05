import Cocoa

// Curated settings window: the ~8-10 options people actually flip (speaker
// recognition, diarization, alerts, language...) out of the ~50 keys in
// config.json. Everything else stays a JSON edit via "Open Config File…".
final class SettingsWindowController: NSWindowController {
    private let diarizationCheckbox = NSButton(checkboxWithTitle: "Speaker Diarization", target: nil, action: nil)
    private let speakerRegistryCheckbox = NSButton(checkboxWithTitle: "Speaker Recognition (cross-session voice registry)", target: nil, action: nil)
    private let attentionCheckbox = NSButton(checkboxWithTitle: "Attention Alerts (trigger words)", target: nil, action: nil)
    private let summaryCheckbox = NSButton(checkboxWithTitle: "Live Meeting Summary", target: nil, action: nil)
    private let parakeetCheckbox = NSButton(checkboxWithTitle: "Parakeet A/B Compare Pass", target: nil, action: nil)
    private let lowerPriorityCheckbox = NSButton(checkboxWithTitle: "Lower Transcription Process Priority", target: nil, action: nil)
    private let languageField = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 24))
    private let chunkDurationField = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 24))
    private let matchThresholdField = NSTextField(frame: NSRect(x: 0, y: 0, width: 100, height: 24))

    private var config: [String: Any] = [:]

    convenience init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 480),
            styleMask: [.titled, .closable],
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
        diarizationCheckbox.state = ConfigStore.bool(config, "diarizationEnabled", default: true) ? .on : .off
        speakerRegistryCheckbox.state = ConfigStore.bool(config, "speakerRegistryEnabled", default: false) ? .on : .off
        attentionCheckbox.state = ConfigStore.bool(config, "attentionAlerts", default: true) ? .on : .off
        summaryCheckbox.state = ConfigStore.bool(config, "summaryEnabled", default: true) ? .on : .off
        parakeetCheckbox.state = ConfigStore.bool(config, "parakeetComparePass", default: true) ? .on : .off
        lowerPriorityCheckbox.state = ConfigStore.bool(config, "lowerProcessPriority", default: true) ? .on : .off
        languageField.stringValue = ConfigStore.string(config, "language", default: "ru")
        chunkDurationField.stringValue = String(ConfigStore.int(config, "chunkDurationSeconds", default: 15))
        matchThresholdField.stringValue = String(ConfigStore.double(config, "speakerMatchThreshold", default: 0.75))
    }

    @objc private func save() {
        config["diarizationEnabled"] = diarizationCheckbox.state == .on
        config["speakerRegistryEnabled"] = speakerRegistryCheckbox.state == .on
        config["attentionAlerts"] = attentionCheckbox.state == .on
        config["summaryEnabled"] = summaryCheckbox.state == .on
        config["parakeetComparePass"] = parakeetCheckbox.state == .on
        config["lowerProcessPriority"] = lowerPriorityCheckbox.state == .on
        config["language"] = languageField.stringValue
        if let n = Int(chunkDurationField.stringValue), n > 0 { config["chunkDurationSeconds"] = n }
        if let d = Double(matchThresholdField.stringValue), (0...1).contains(d) { config["speakerMatchThreshold"] = d }

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
            labeledRow("Chunk Duration (seconds):", chunkDurationField),
            separator(),
            sectionLabel("Speakers"),
            diarizationCheckbox,
            speakerRegistryCheckbox,
            labeledRow("Speaker Match Threshold (0–1):", matchThresholdField),
            separator(),
            sectionLabel("Alerts & Passes"),
            attentionCheckbox,
            summaryCheckbox,
            parakeetCheckbox,
            lowerPriorityCheckbox,
            separator(),
            openConfigButton,
            actionRow,
        ])
        mainStack.orientation = .vertical
        mainStack.alignment = .leading
        mainStack.spacing = 12
        mainStack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        mainStack.translatesAutoresizingMaskIntoConstraints = false

        contentView.addSubview(mainStack)
        NSLayoutConstraint.activate([
            mainStack.topAnchor.constraint(equalTo: contentView.topAnchor),
            mainStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            mainStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
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

    private func separator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        box.widthAnchor.constraint(equalToConstant: 380).isActive = true
        return box
    }
}
