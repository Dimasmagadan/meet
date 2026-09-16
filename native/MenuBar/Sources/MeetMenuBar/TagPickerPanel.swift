import Cocoa

// Dropdown-style tag/title picker anchored to the status item, replacing the old
// NSAlert-based flow (see git history). NSAlert.runModal() centers its window on
// whatever screen holds the key window — on a multi-display/multi-Space setup that
// can land far from the tray icon the user actually clicked, and being app-modal it
// blocks the menu bar until found, which reads as the whole app having frozen.
// Anchoring here to the status item's own button frame keeps the panel exactly where
// the click came from, and re-asserting position/order on Space switches (mirrors
// NotchPanelController's activeSpaceDidChangeNotification handling) keeps it visible
// after a swipe instead of stranding it on the Space it was opened from.
final class TagPickerPanel: NSObject {
    typealias PickerResult = (tags: [String], title: String)

    private static let width: CGFloat = 280
    private static let padding: CGFloat = 14
    private static let rowHeight: CGFloat = 22
    private static let fieldHeight: CGFloat = 24
    private static let rowSpacing: CGFloat = 6
    private static let cornerRadius: CGFloat = 10

    private var panel: PickerPanel?
    private var titleField: NSTextField?
    private var newTagField: NSTextField?
    private var checkboxes: [NSButton] = []
    private var completion: ((PickerResult?) -> Void)?
    private weak var anchorButton: NSStatusBarButton?
    private var outsideClickMonitor: Any?
    private var finished = false

    override init() {
        super.init()
        NSWorkspace.shared.notificationCenter.addObserver(
            self, selector: #selector(activeSpaceChanged),
            name: NSWorkspace.activeSpaceDidChangeNotification, object: nil
        )
    }

    deinit {
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        removeOutsideClickMonitor()
    }

    @objc private func activeSpaceChanged() {
        guard let panel = panel, panel.isVisible, let button = anchorButton else { return }
        panel.setFrameOrigin(Self.origin(below: button, panelSize: panel.frame.size))
        panel.orderFrontRegardless()
    }

    func show(
        anchor button: NSStatusBarButton,
        message: String,
        info: String,
        okTitle: String,
        existingTags: [String],
        preChecked: [String],
        defaultTitle: String,
        completion: @escaping (PickerResult?) -> Void
    ) {
        // A second invocation (e.g. Stop clicked again while the panel is still up)
        // cancels the stale one rather than stacking panels.
        dismiss(result: nil)

        self.completion = completion
        self.anchorButton = button
        self.finished = false

        let content = buildContent(message: message, info: info, okTitle: okTitle, existingTags: existingTags, preChecked: preChecked, defaultTitle: defaultTitle)

        let panel = PickerPanel(
            contentRect: NSRect(origin: .zero, size: content.frame.size),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered, defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .popUpMenu
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.contentView = content
        panel.setFrameOrigin(Self.origin(below: button, panelSize: content.frame.size))

        self.panel = panel
        panel.makeKeyAndOrderFront(nil)
        if let newTagField = newTagField {
            panel.makeFirstResponder(newTagField)
        }

        // Any click outside the panel — another app, the desktop, a different menu —
        // cancels it, matching how a standard menu/popover dismisses.
        outsideClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.dismiss(result: nil)
        }
    }

    private func removeOutsideClickMonitor() {
        if let monitor = outsideClickMonitor {
            NSEvent.removeMonitor(monitor)
            outsideClickMonitor = nil
        }
    }

    @objc private func handleOK() {
        var selected = checkboxes.filter { $0.state == .on }.map { $0.title }
        let newTag = (newTagField?.stringValue ?? "").trimmingCharacters(in: .whitespaces)
        if !newTag.isEmpty { selected.append(newTag) }
        let title = titleField?.stringValue ?? ""
        dismiss(result: (tags: selected, title: title))
    }

    @objc private func handleCancel() {
        dismiss(result: nil)
    }

    private func dismiss(result: PickerResult?) {
        guard !finished else { return }
        finished = true
        removeOutsideClickMonitor()
        panel?.orderOut(nil)
        panel = nil
        titleField = nil
        newTagField = nil
        checkboxes = []
        let cb = completion
        completion = nil
        cb?(result)
    }

    // MARK: - Layout

    // Top-down layout in a flipped container (y grows downward from the padded top edge,
    // same reading order as the visible rows: title/info, fields, buttons last at the
    // bottom) — no separate flip pass needed once the container itself is flipped.
    private func buildContent(message: String, info: String, okTitle: String, existingTags: [String], preChecked: [String], defaultTitle: String) -> NSView {
        let width = Self.width
        var y: CGFloat = Self.padding
        var rows: [NSView] = []

        let messageLabel = Self.label(message, size: 13, color: .labelColor, width: width - Self.padding * 2, bold: true)
        messageLabel.frame.origin = NSPoint(x: Self.padding, y: y)
        rows.append(messageLabel)
        y += messageLabel.frame.height + 2

        let infoLabel = Self.label(info, size: 11, color: .secondaryLabelColor, width: width - Self.padding * 2)
        infoLabel.frame.origin = NSPoint(x: Self.padding, y: y)
        rows.append(infoLabel)
        y += infoLabel.frame.height + Self.padding

        let titleField = NSTextField(frame: NSRect(x: Self.padding, y: y, width: width - Self.padding * 2, height: Self.fieldHeight))
        titleField.stringValue = defaultTitle
        titleField.placeholderString = "Meeting title"
        titleField.target = self
        titleField.action = #selector(handleOK)
        self.titleField = titleField
        rows.append(titleField)
        y += Self.fieldHeight + Self.rowSpacing

        for tag in existingTags {
            let checkbox = NSButton(checkboxWithTitle: tag, target: nil, action: nil)
            checkbox.frame = NSRect(x: Self.padding, y: y, width: width - Self.padding * 2, height: Self.rowHeight)
            if preChecked.contains(where: { $0.caseInsensitiveCompare(tag) == .orderedSame }) { checkbox.state = .on }
            checkboxes.append(checkbox)
            rows.append(checkbox)
            y += Self.rowHeight + 2
        }
        if !existingTags.isEmpty { y += Self.rowSpacing - 2 }

        let newTagField = NSTextField(frame: NSRect(x: Self.padding, y: y, width: width - Self.padding * 2, height: Self.fieldHeight))
        newTagField.placeholderString = "New tag"
        newTagField.target = self
        newTagField.action = #selector(handleOK)
        self.newTagField = newTagField
        rows.append(newTagField)
        y += Self.fieldHeight + Self.padding

        let buttonRow = buildButtonRow(okTitle: okTitle, width: width)
        buttonRow.frame.origin = NSPoint(x: 0, y: y)
        rows.append(buttonRow)
        y += buttonRow.frame.height + Self.padding

        let totalHeight = y

        let effectView = FlippedVisualEffectView(frame: NSRect(x: 0, y: 0, width: width, height: totalHeight))
        effectView.material = .popover
        effectView.blendingMode = .behindWindow
        effectView.state = .active
        effectView.wantsLayer = true
        effectView.layer?.cornerRadius = Self.cornerRadius
        effectView.layer?.masksToBounds = true
        for row in rows { effectView.addSubview(row) }

        return effectView
    }

    // Buttons sit right-aligned with the same Self.padding margin as every other row,
    // so they never touch the panel's edge.
    private func buildButtonRow(okTitle: String, width: CGFloat) -> NSView {
        let row = NSView(frame: NSRect(x: 0, y: 0, width: width, height: Self.fieldHeight))
        let cancelButton = NSButton(title: "Cancel", target: self, action: #selector(handleCancel))
        cancelButton.bezelStyle = .rounded
        cancelButton.keyEquivalent = "\u{1b}"
        cancelButton.sizeToFit()

        let okButton = NSButton(title: okTitle, target: self, action: #selector(handleOK))
        okButton.bezelStyle = .rounded
        okButton.keyEquivalent = "\r"
        okButton.sizeToFit()

        let okX = width - Self.padding - okButton.frame.width
        okButton.frame.origin = NSPoint(x: okX, y: 0)
        let cancelX = okX - 8 - cancelButton.frame.width
        cancelButton.frame.origin = NSPoint(x: cancelX, y: 0)

        row.addSubview(cancelButton)
        row.addSubview(okButton)
        row.frame.size.height = max(okButton.frame.height, cancelButton.frame.height)
        return row
    }

    private static func label(_ text: String, size: CGFloat, color: NSColor, width: CGFloat, bold: Bool = false) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = bold ? .boldSystemFont(ofSize: size) : .systemFont(ofSize: size)
        field.textColor = color
        field.frame = NSRect(x: 0, y: 0, width: width, height: 100)
        field.frame.size = field.sizeThatFits(NSSize(width: width, height: .greatestFiniteMagnitude))
        return field
    }

    // Left-aligned under the status item's button, clamped to the button's own screen
    // so it never drifts onto a neighboring display.
    private static func origin(below button: NSStatusBarButton, panelSize: NSSize) -> NSPoint {
        guard let buttonWindow = button.window else { return .zero }
        let buttonFrameInScreen = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let screen = buttonWindow.screen ?? NSScreen.main
        var x = buttonFrameInScreen.minX
        if let screen = screen {
            x = min(x, screen.frame.maxX - panelSize.width - 4)
            x = max(x, screen.frame.minX + 4)
        }
        let y = buttonFrameInScreen.minY - panelSize.height - 4
        return NSPoint(x: x, y: y)
    }
}

// Borderless panels return canBecomeKey == false by default, which would leave the
// text fields unable to take keyboard input; .nonactivatingPanel still keeps the app
// itself from activating (Dock icon, app switcher) while this is up.
private final class PickerPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// Top-left origin so buildContent can lay out rows in natural reading order (message
// first, buttons last) without a separate bottom-up-to-top-down flip pass.
private final class FlippedVisualEffectView: NSVisualEffectView {
    override var isFlipped: Bool { true }
}
