import Cocoa

// Single hover-revealed panel anchored at the physical notch. See
// specs/SPEC_NOTCH_TRANSCRIPT_PANEL_2026-08-03.md (base) and
// specs/SPEC_NOTCH_TABS_2026-08-12.md (Ask AI mode). The window's collapsed
// frame *is* the notch rect (a physical cutout, so a window there is
// invisible by definition) — hovering it grows the same window downward.
final class NotchPanelController: NSObject {
    static let maxLines = 4
    static let placeholder = "Ждём данные…"

    private static let panelWidth: CGFloat = 400
    private static let expandedHeight: CGFloat = 160
    // ~60 reading columns at 14pt, not a measured character count.
    private static let bigWidth: CGFloat = 620
    private static let bigHeightFraction: CGFloat = 0.5
    private static let buttonSize = NSSize(width: 72, height: 20)
    private static let hideDelay: TimeInterval = 0.35
    private static let pollInterval: TimeInterval = 1.0
    // Scrollback shown once expanded; tail-4 stays the pure-function default (see selfCheckTailExtraction).
    private static let scrollbackLines = 200
    // No public API exposes the physical notch's corner radius; 12pt matches it visually
    // on 14"/16" MacBook Pro (M1 Pro+).
    private static let notchCornerRadius: CGFloat = 12

    // Ask AI mode (SPEC_NOTCH_TABS_2026-08-12).
    private static let askRowHeight: CGFloat = 32
    private static let askFieldHeight: CGFloat = 24
    private static let askSubmitWidth: CGFloat = 80
    private static let askPlaceholder = "Спросите что-нибудь о встрече…"
    private static let askWaiting = "Ждём ответ…"

    enum Mode {
        case transcript
        case askAI
    }

    private var panel: NSPanel?
    private var scrollView: NSScrollView?
    private var textView: NSTextView?
    private var expandButton: NSButton?
    private var modeButton: NSButton?
    private var askField: NSTextField?
    private var askSubmitButton: NSButton?
    private var collapsedFrame: NSRect = .zero
    private var expandedFrame: NSRect = .zero
    private var bigFrame: NSRect = .zero
    private var isBigExpanded = false
    private var notchHeight: CGFloat = 0
    private var pollTimer: Timer?
    private var hideWorkItem: DispatchWorkItem?
    private var armed = false

    private var mode: Mode = .transcript
    private var pendingAskId: String?
    private var askInFlight = false
    private var lastAnswer: String?
    private var askTicks = 0

    // Wired by AppDelegate — calls RecordingController.ask(question:), which spawns
    // `meet ask` synchronously. The panel itself stays a lock-file/marker reader.
    var onAsk: ((String) -> Bool)?

    override init() {
        super.init()
        // Auto-start can fire while the notch screen is unavailable (lid closed with an
        // external display, screen asleep, remote session) — arm() no-ops in that case and
        // setArmed() never retries on its own. Re-resolving on screen changes catches the
        // notch display coming back (lid opened, external monitor unplugged) mid-recording.
        NotificationCenter.default.addObserver(
            self, selector: #selector(screenParametersChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func screenParametersChanged() {
        guard armed else { return }
        arm()
    }

    func setArmed(_ shouldArm: Bool) {
        guard shouldArm != armed else { return }
        armed = shouldArm
        shouldArm ? arm() : disarm()
    }

    // MARK: - Arm / disarm

    private func arm() {
        guard let screen = Self.notchScreen(), let notch = Self.notchRect(on: screen) else { return }

        notchHeight = notch.height
        // Collapsed frame must not exceed the notch's own bounds — anything wider peeks
        // out past the physical cutout as a visible black bar. No extra hover margin.
        collapsedFrame = notch
        expandedFrame = NSRect(
            x: notch.midX - Self.panelWidth / 2,
            y: notch.maxY - Self.expandedHeight,
            width: Self.panelWidth,
            height: Self.expandedHeight
        )
        let bigHeight = screen.frame.height * Self.bigHeightFraction
        bigFrame = NSRect(
            x: notch.midX - Self.bigWidth / 2,
            y: notch.maxY - bigHeight,
            width: Self.bigWidth,
            height: bigHeight
        )

        if panel == nil {
            setUpPanel()
        }
        panel?.setFrame(collapsedFrame, display: true)
        panel?.orderFrontRegardless()
    }

    private func disarm() {
        stopPolling()
        hideWorkItem?.cancel()
        askInFlight = false
        pendingAskId = nil
        lastAnswer = nil
        askTicks = 0
        setMode(.transcript, animated: false)
        panel?.orderOut(nil)
    }

    private func setUpPanel() {
        // KeyPanel (not NSPanel): a borderless window returns canBecomeKey == false by
        // default, so an NSTextField can never take keyboard input. The subclass flips
        // that, and panel.makeKey() is called when entering Ask AI mode. .nonactivatingPanel
        // still keeps the app itself from activating (same reason FirstMouseButton exists).
        let panel = KeyPanel(contentRect: collapsedFrame, styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isOpaque = false
        // .clear, not .black: the window's own background fills the full square frame
        // regardless of the content layer's rounded-corner clip below, so a black window
        // bg would paint solid black right through the "rounded off" corners, masking
        // the rounding entirely. Only the content layer should paint black.
        panel.backgroundColor = .clear
        panel.hasShadow = false
        // Content is always painted black (line below), independent of system light/dark
        // mode — force dark appearance so button/text labels render light-on-dark instead
        // of inheriting the system's light-mode dark label color onto a black background.
        panel.appearance = NSAppearance(named: .darkAqua)

        let initialSize = NSSize(width: Self.panelWidth, height: Self.expandedHeight)

        // Text starts below the physical notch cutout, not at the window's top edge —
        // the window itself still spans the full notch-to-expandedHeight rect (matches
        // notch black so the collapsed->expanded grow reads as one shape).
        let scrollFrame = Self.scrollFrame(for: initialSize, notchHeight: notchHeight)

        let scrollView = NSScrollView(frame: scrollFrame)
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        let textView = NSTextView(frame: NSRect(origin: .zero, size: scrollView.contentSize))
        textView.string = Self.placeholder
        textView.font = .systemFont(ofSize: 14)
        textView.textColor = .white
        textView.drawsBackground = false
        textView.isEditable = false
        textView.isSelectable = true
        textView.textContainerInset = .zero
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: scrollView.contentSize.width, height: .greatestFiniteMagnitude)

        scrollView.documentView = textView

        let expandButton = FirstMouseButton(title: "Раскрыть", target: self, action: #selector(toggleBigExpand))
        expandButton.bezelStyle = .inline
        expandButton.font = .systemFont(ofSize: 11)
        expandButton.frame = Self.buttonFrame(for: initialSize, notchHeight: notchHeight, slot: 0)

        // Mode toggle: "Ask AI" ↔ "Транскрипт" — sits left of "Раскрыть" (slot 1).
        let modeButton = FirstMouseButton(title: "Ask AI", target: self, action: #selector(toggleMode))
        modeButton.bezelStyle = .inline
        modeButton.font = .systemFont(ofSize: 11)
        modeButton.frame = Self.buttonFrame(for: initialSize, notchHeight: notchHeight, slot: 1)

        // Ask input row — visible only in Ask AI mode.
        let askRow = Self.askRowFrame(for: initialSize)
        let askField = NSTextField(frame: askRow.field)
        askField.placeholderString = "Вопрос"
        askField.font = .systemFont(ofSize: 13)
        askField.bezelStyle = .roundedBezel
        askField.focusRingType = .none
        askField.appearance = NSAppearance(named: .vibrantDark)
        askField.target = self
        askField.action = #selector(submitAsk)
        askField.isHidden = true

        let askSubmitButton = FirstMouseButton(title: "Спросить", target: self, action: #selector(submitAsk))
        askSubmitButton.bezelStyle = .inline
        askSubmitButton.font = .systemFont(ofSize: 11)
        askSubmitButton.frame = askRow.button
        askSubmitButton.isHidden = true

        let content = TrackingView(frame: collapsedFrame)
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.black.cgColor
        // TrackingView is non-flipped (origin at bottom-left), so "bottom" corners are the minY ones.
        content.layer?.cornerRadius = Self.notchCornerRadius
        content.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        content.layer?.masksToBounds = true
        content.addSubview(scrollView)
        content.addSubview(expandButton)
        content.addSubview(modeButton)
        content.addSubview(askField)
        content.addSubview(askSubmitButton)
        content.onHoverChange = { [weak self] hovering in self?.handleHover(hovering) }

        panel.contentView = content
        self.panel = panel
        self.scrollView = scrollView
        self.textView = textView
        self.expandButton = expandButton
        self.modeButton = modeButton
        self.askField = askField
        self.askSubmitButton = askSubmitButton
    }

    // MARK: - Hover

    private func handleHover(_ hovering: Bool) {
        hideWorkItem?.cancel()
        if hovering {
            startPolling()
            animate(to: currentTargetFrame())
        } else {
            // Hover-hide suppression (§2.3): skip scheduling the hide when Ask AI mode
            // is active AND (the field is non-empty OR a question is in flight). An empty
            // field with nothing pending still auto-hides, so the panel never dead-ends.
            if shouldSuppressHide { return }
            let workItem = DispatchWorkItem { [weak self] in self?.collapse() }
            hideWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.hideDelay, execute: workItem)
        }
    }

    private var shouldSuppressHide: Bool {
        guard mode == .askAI else { return false }
        if askInFlight { return true }
        if let field = askField, !field.stringValue.trimmingCharacters(in: .whitespaces).isEmpty { return true }
        return false
    }

    private func currentTargetFrame() -> NSRect {
        if mode == .askAI { return bigFrame }
        return isBigExpanded ? bigFrame : expandedFrame
    }

    private func collapse() {
        // §2.3: resets the mode to Транскрипт but keeps pendingAskId and the last answer.
        // Re-entering Ask AI shows the last answer, or resumes polling if the question is
        // still outstanding.
        stopPolling()
        setMode(.transcript, animated: false)
        isBigExpanded = false
        expandButton?.title = "Раскрыть"
        animate(to: collapsedFrame)
    }

    // Toggles the reading-size panel (50% screen height) on and off; resets to the
    // small hover size whenever the panel fully collapses (see collapse()).
    @objc private func toggleBigExpand() {
        guard mode == .transcript else { return }
        hideWorkItem?.cancel()
        isBigExpanded.toggle()
        expandButton?.title = isBigExpanded ? "Свернуть" : "Раскрыть"
        animate(to: currentTargetFrame())
    }

    // MARK: - Mode switching (SPEC_NOTCH_TABS_2026-08-12)

    @objc private func toggleMode() {
        hideWorkItem?.cancel()
        switch mode {
        case .transcript:
            setMode(.askAI)
        case .askAI:
            setMode(.transcript)
        }
    }

    private func setMode(_ newMode: Mode, animated: Bool = true) {
        mode = newMode
        switch newMode {
        case .transcript:
            modeButton?.title = "Ask AI"
            expandButton?.isHidden = false
            askField?.isHidden = true
            askSubmitButton?.isHidden = true
            // Release key focus so keystrokes return to the app underneath (Zoom, Meet,
            // terminal). The panel stays non-activating throughout.
            if let keyPanel = panel as? KeyPanel {
                keyPanel.allowsKey = false
                keyPanel.resignKey()
            }
            if animated { animate(to: currentTargetFrame()) }
            updateTranscript()

        case .askAI:
            modeButton?.title = "Транскрипт"
            expandButton?.isHidden = true
            askField?.isHidden = false
            askSubmitButton?.isHidden = false
            // Force bigFrame — the 160pt hover height can't hold a field, an answer,
            // and two button rows.
            if animated { animate(to: bigFrame) }
            // Flip allowsKey before makeKey so the dynamic canBecomeKey returns true.
            (panel as? KeyPanel)?.allowsKey = true
            panel?.makeKey()

            if askInFlight {
                // Question still outstanding (e.g. re-entered after away-and-back) — resume polling.
                textView?.string = Self.askWaiting
                askField?.isEnabled = false
                askSubmitButton?.isEnabled = false
            } else {
                askField?.isEnabled = true
                askSubmitButton?.isEnabled = true
                askField?.stringValue = ""
                textView?.string = lastAnswer ?? Self.askPlaceholder
                panel?.makeFirstResponder(askField)
            }
        }
    }

    // MARK: - Ask AI submit (SPEC_NOTCH_TABS_2026-08-12 §3.2)

    @objc private func submitAsk() {
        guard mode == .askAI, !askInFlight else { return }
        let question = (askField?.stringValue ?? "").trimmingCharacters(in: .whitespaces)
        guard !question.isEmpty else { return }

        // Clear any stale response from a previous question before submitting.
        if let sessionDir = Self.currentSessionDir() {
            let responsePath = "\(sessionDir)/ask-response.json"
            try? FileManager.default.removeItem(atPath: responsePath)
        }

        // onAsk spawns `meet ask` synchronously — after it returns, ask-request.json exists.
        guard let onAsk = onAsk, onAsk(question) else {
            textView?.string = "Не удалось отправить вопрос."
            return
        }

        // Read the id written by `meet ask` so we can distinguish a fresh response from a stale one.
        pendingAskId = readAskRequestId()
        askInFlight = true
        askTicks = 0

        askField?.stringValue = ""
        askField?.isEnabled = false
        askSubmitButton?.isEnabled = false
        textView?.string = Self.askWaiting
    }

    private func readAskRequestId() -> String? {
        guard let sessionDir = Self.currentSessionDir() else { return nil }
        let path = "\(sessionDir)/ask-request.json"
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = json["id"] as? String else { return nil }
        return id
    }

    private func animate(to frame: NSRect) {
        guard let panel = panel else { return }
        let size = frame.size
        let bottomInset = (mode == .askAI) ? Self.askRowHeight : 0
        let newScrollFrame = Self.scrollFrame(for: size, notchHeight: notchHeight, bottomInset: bottomInset)
        let newExpandFrame = Self.buttonFrame(for: size, notchHeight: notchHeight, slot: 0)
        let newModeFrame = Self.buttonFrame(for: size, notchHeight: notchHeight, slot: 1)
        let askRow = Self.askRowFrame(for: size)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            panel.animator().setFrame(frame, display: true)
            scrollView?.animator().frame = newScrollFrame
            expandButton?.animator().frame = newExpandFrame
            modeButton?.animator().frame = newModeFrame
            askField?.animator().frame = askRow.field
            askSubmitButton?.animator().frame = askRow.button
        }
    }

    // MARK: - Polling

    private func startPolling() {
        stopPolling()
        pollTick()
        pollTimer = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            self?.pollTick()
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // Same timer, one branch: transcript tail vs. ask response.
    private func pollTick() {
        switch mode {
        case .transcript:
            updateTranscript()
        case .askAI:
            pollAskResponse()
        }
    }

    private func updateTranscript() {
        let body: String
        if let path = Self.currentOutputFile(), let content = try? String(contentsOfFile: path, encoding: .utf8) {
            body = Self.tailLines(from: content, maxLines: Self.scrollbackLines).joined(separator: "\n")
        } else {
            body = Self.placeholder
        }
        // §2.1: prefix "Участники: A, B" when the lock carries non-empty attendees;
        // prefix nothing when it doesn't (no "Нет данных" noise for manual starts).
        let text = Self.assembleDisplayText(body: body, attendees: Self.currentAttendees())

        guard let textView = textView, let scrollView = scrollView else { return }
        let stickToBottom = isScrolledToBottom(scrollView)
        textView.string = text
        if stickToBottom {
            textView.scrollToEndOfDocument(nil)
        }
    }

    private func pollAskResponse() {
        guard askInFlight else { return }
        askTicks += 1

        // Deadline: opencode has a 60s timeout (opencode.ts), so a response should land
        // within ~62s (60s + file write + one poll tick). 90s gives margin for scheduling
        // jitter; if it still hasn't arrived the Recorder likely died before writing the
        // marker, so we unlock the field rather than hanging forever.
        if askTicks > 90 {
            askInFlight = false
            pendingAskId = nil
            textView?.string = "Ответ не пришёл."
            askField?.isEnabled = true
            askSubmitButton?.isEnabled = true
            if let panel = panel, let field = askField {
                panel.makeFirstResponder(field)
            }
            return
        }

        guard let sessionDir = Self.currentSessionDir() else { return }
        let responsePath = "\(sessionDir)/ask-response.json"
        guard FileManager.default.fileExists(atPath: responsePath) else { return }

        guard let data = FileManager.default.contents(atPath: responsePath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            try? FileManager.default.removeItem(atPath: responsePath)
            return
        }

        let responseId = json["id"] as? String
        // Matching id check — a stale response from a different question is ignored + deleted.
        // When pendingAskId is nil (race: Recorder deleted the marker before we read its id),
        // accept any response — the stale-response.json was already cleared on submit.
        if let expectedId = pendingAskId, responseId != expectedId {
            try? FileManager.default.removeItem(atPath: responsePath)
            return
        }

        try? FileManager.default.removeItem(atPath: responsePath)
        askInFlight = false
        pendingAskId = nil

        if let answer = json["answer"] as? String, !answer.isEmpty {
            lastAnswer = answer
            textView?.string = answer
        } else if let error = json["error"] as? String {
            textView?.string = "Ошибка: \(error)"
        } else {
            textView?.string = "Пустой ответ."
        }

        askField?.isEnabled = true
        askSubmitButton?.isEnabled = true
        if let panel = panel, let field = askField, mode == .askAI {
            panel.makeFirstResponder(field)
        }
    }

    // New chunks land at the bottom; only auto-follow if the user hasn't scrolled
    // up to read history, same as a chat/log view.
    private func isScrolledToBottom(_ scrollView: NSScrollView) -> Bool {
        let visibleMaxY = scrollView.contentView.bounds.maxY
        let documentHeight = scrollView.documentView?.frame.height ?? 0
        return visibleMaxY >= documentHeight - 4
    }

    // MARK: - Pure helpers (see selfCheckTailExtraction)

    // Text starts below the physical notch cutout *and* the button row at any panel
    // size (collapsed, hover, or big-expanded) — insets are constant since neither the
    // notch nor the button resize. bottomInset > 0 (Ask AI mode) reserves space for the
    // ask input row; 0 keeps today's layout byte-identical.
    static func scrollFrame(for size: NSSize, notchHeight: CGFloat, bottomInset: CGFloat = 0) -> NSRect {
        let topInset = notchHeight + 4 + buttonSize.height
        return NSRect(x: 10, y: 6 + bottomInset, width: size.width - 20, height: size.height - 6 - topInset - bottomInset)
    }

    // Sits in its own row directly below the notch's dead zone — anything placed
    // above that line is physically hidden by the cutout, invisible to the user.
    // Slots lay out right-to-left: slot 0 = "Раскрыть" (rightmost), slot 1 = mode button.
    static func buttonFrame(for size: NSSize, notchHeight: CGFloat, slot: Int = 0) -> NSRect {
        let rowTop = size.height - notchHeight - 4
        let x = size.width - buttonSize.width - 8 - CGFloat(slot) * (buttonSize.width + 8)
        return NSRect(x: x, y: rowTop - buttonSize.height, width: buttonSize.width, height: buttonSize.height)
    }

    // Ask input row at the bottom of the panel: field + "Спросить" button side by side.
    static func askRowFrame(for size: NSSize) -> (field: NSRect, button: NSRect) {
        let margin: CGFloat = 10
        let gap: CGFloat = 6
        let buttonX = size.width - askSubmitWidth - margin
        let fieldWidth = buttonX - gap - margin
        let fieldFrame = NSRect(x: margin, y: 6, width: fieldWidth, height: askFieldHeight)
        let buttonFrame = NSRect(x: buttonX, y: 6, width: askSubmitWidth, height: askFieldHeight)
        return (fieldFrame, buttonFrame)
    }

    static func attendeeHeader(from attendees: [String]) -> String {
        "Участники: " + attendees.joined(separator: ", ")
    }

    // Prefixes the body with the attendee line when non-empty; returns body unchanged otherwise.
    static func assembleDisplayText(body: String, attendees: [String]) -> String {
        if attendees.isEmpty { return body }
        return attendeeHeader(from: attendees) + "\n" + body
    }

    static func notchScreen() -> NSScreen? {
        NSScreen.screens.first { notchRect(on: $0) != nil }
    }

    static func notchRect(on screen: NSScreen?) -> NSRect? {
        guard let screen = screen, screen.safeAreaInsets.top > 0,
              let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea else { return nil }
        return NSRect(x: left.maxX, y: left.minY, width: right.minX - left.maxX, height: left.height)
    }

    static func currentOutputFile() -> String? {
        ActiveLock.read()?["outputFile"] as? String
    }

    static func currentSessionDir() -> String? {
        ActiveLock.read()?["sessionDir"] as? String
    }

    static func currentAttendees() -> [String] {
        (ActiveLock.read()?["attendees"] as? [String]) ?? []
    }

    // Drops the `# Title — date` header + blank line, keeps only `**[`-prefixed
    // entry lines, returns the last maxLines with the markdown `**` stripped for
    // plain-text display; placeholder when there are no entry lines yet.
    static func tailLines(from content: String, maxLines: Int) -> [String] {
        let entryLines = content
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map(String.init)
            .filter { $0.hasPrefix("**[") }
        guard !entryLines.isEmpty else { return [placeholder] }
        return entryLines.suffix(maxLines).map { $0.replacingOccurrences(of: "**", with: "") }
    }

    // Runnable check for the non-trivial logic here (no XCTest target in this package).
    // Invoked via `--self-test-notch` in main.swift.
    static func selfCheckTailExtraction() {
        let header = "# Standup — 03.08.2026 10:00\n\n"
        let entries = (1...6).map { "**[10:0\($0):00] Me:** line \($0)\n" }.joined()
        let tail = tailLines(from: header + entries, maxLines: 4)
        assert(tail.count == 4, "expected 4 lines, got \(tail.count)")
        assert(tail.first!.contains("line 3"), "expected tail to start at entry 3, got \(tail.first!)")
        assert(!tail.contains(where: { $0.hasPrefix("#") }), "header leaked into tail")
        assert(!tail.contains(where: { $0.contains("**") }), "markdown markers not stripped")

        let empty = tailLines(from: header, maxLines: 4)
        assert(empty == [placeholder], "expected placeholder for header-only content")

        // Attendee header (§2.1): non-empty → "Участники: …"; empty → no line at all.
        assert(attendeeHeader(from: ["Alice", "Bob"]) == "Участники: Alice, Bob")
        assert(assembleDisplayText(body: "line1", attendees: ["Alice", "Bob"]) == "Участники: Alice, Bob\nline1")
        assert(assembleDisplayText(body: "line1", attendees: []) == "line1")

        // buttonFrame slots 0 and 1 don't overlap at hover width (§3.3).
        let hoverSize = NSSize(width: panelWidth, height: expandedHeight)
        let nh: CGFloat = 32
        let slot0 = buttonFrame(for: hoverSize, notchHeight: nh, slot: 0)
        let slot1 = buttonFrame(for: hoverSize, notchHeight: nh, slot: 1)
        assert(slot0.minX >= slot1.maxX, "button slots overlap at hover width")
        assert(slot0.maxX > slot1.maxX, "slot 0 should be rightmost")

        // scrollFrame with a bottom inset stays inside the panel; 0 inset is byte-identical.
        let scrollWithInset = scrollFrame(for: hoverSize, notchHeight: nh, bottomInset: askRowHeight)
        assert(scrollWithInset.minY >= 0, "scroll frame below panel bottom")
        assert(scrollWithInset.maxY <= hoverSize.height, "scroll frame above panel top")
        let scrollNoInset = scrollFrame(for: hoverSize, notchHeight: nh, bottomInset: 0)
        let oldTopInset = nh + 4 + buttonSize.height
        let oldScroll = NSRect(x: 10, y: 6, width: hoverSize.width - 20, height: hoverSize.height - 6 - oldTopInset)
        assert(scrollNoInset == oldScroll, "scroll frame changed with zero bottom inset")

        print("NotchPanelController.selfCheckTailExtraction: OK")
    }
}

// NSTrackingArea rebuilt on every bounds change (collapse <-> expand) via the
// AppKit-driven updateTrackingAreas() callback. Must be .activeAlways: the
// panel is never the app's main window, so the default .activeInKeyWindow silently
// never fires.
private final class TrackingView: NSView {
    var onHoverChange: ((Bool) -> Void)?
    private var trackingArea: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingArea = trackingArea { removeTrackingArea(trackingArea) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) { onHoverChange?(true) }
    override func mouseExited(with event: NSEvent) { onHoverChange?(false) }
}

// The panel never activates the app (.nonactivatingPanel), so without this override the
// button's first click would just be swallowed as a "wake up the window" click.
private final class FirstMouseButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// A borderless NSPanel returns canBecomeKey == false by default, so an NSTextField in
// it can never take keyboard input. allowsKey is flipped to true only while Ask AI mode
// is active, so leaving the mode (or collapsing) releases key focus back to the app
// underneath (Zoom, Meet, terminal) instead of trapping keystrokes in a hidden panel
// (SPEC_NOTCH_TABS_2026-08-12 §2.3).
private final class KeyPanel: NSPanel {
    var allowsKey = false
    override var canBecomeKey: Bool { allowsKey }
}
