import Cocoa

// Single hover-revealed panel anchored at the physical notch. See
// specs/SPEC_NOTCH_TRANSCRIPT_PANEL_2026-08-03.md. The window's collapsed
// frame *is* the notch rect (a physical cutout, so a window there is
// invisible by definition) — hovering it grows the same window downward.
final class NotchPanelController {
    static let maxLines = 4
    static let placeholder = "Ждём данные…"

    private static let panelWidth: CGFloat = 400
    private static let expandedHeight: CGFloat = 160
    private static let hideDelay: TimeInterval = 0.35
    private static let pollInterval: TimeInterval = 1.0
    // Scrollback shown once expanded; tail-4 stays the pure-function default (see selfCheckTailExtraction).
    private static let scrollbackLines = 200
    // No public API exposes the physical notch's corner radius; 12pt matches it visually
    // on 14"/16" MacBook Pro (M1 Pro+).
    private static let notchCornerRadius: CGFloat = 12

    private var panel: NSPanel?
    private var scrollView: NSScrollView?
    private var textView: NSTextView?
    private var collapsedFrame: NSRect = .zero
    private var expandedFrame: NSRect = .zero
    private var notchHeight: CGFloat = 0
    private var pollTimer: Timer?
    private var hideWorkItem: DispatchWorkItem?
    private var armed = false

    func setArmed(_ shouldArm: Bool) {
        guard shouldArm != armed else { return }
        armed = shouldArm
        shouldArm ? arm() : disarm()
    }

    // MARK: - Arm / disarm

    private func arm() {
        guard let notch = Self.notchRect(on: NSScreen.main) else { return }

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

        if panel == nil {
            setUpPanel()
        }
        panel?.setFrame(collapsedFrame, display: true)
        panel?.orderFrontRegardless()
    }

    private func disarm() {
        stopPolling()
        hideWorkItem?.cancel()
        panel?.orderOut(nil)
    }

    private func setUpPanel() {
        let panel = NSPanel(contentRect: collapsedFrame, styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
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

        // Text starts below the physical notch cutout, not at the window's top edge —
        // the window itself still spans the full notch-to-expandedHeight rect (matches
        // notch black so the collapsed->expanded grow reads as one shape).
        let topInset = notchHeight + 4
        let scrollFrame = NSRect(x: 10, y: 6, width: Self.panelWidth - 20, height: Self.expandedHeight - 6 - topInset)

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

        let content = TrackingView(frame: collapsedFrame)
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.black.cgColor
        // TrackingView is non-flipped (origin at bottom-left), so "bottom" corners are the minY ones.
        content.layer?.cornerRadius = Self.notchCornerRadius
        content.layer?.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        content.layer?.masksToBounds = true
        content.addSubview(scrollView)
        content.onHoverChange = { [weak self] hovering in self?.handleHover(hovering) }

        panel.contentView = content
        self.panel = panel
        self.scrollView = scrollView
        self.textView = textView
    }

    // MARK: - Hover

    private func handleHover(_ hovering: Bool) {
        hideWorkItem?.cancel()
        if hovering {
            startPolling()
            animate(to: expandedFrame)
        } else {
            let workItem = DispatchWorkItem { [weak self] in self?.collapse() }
            hideWorkItem = workItem
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.hideDelay, execute: workItem)
        }
    }

    private func collapse() {
        stopPolling()
        animate(to: collapsedFrame)
    }

    private func animate(to frame: NSRect) {
        guard let panel = panel else { return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            panel.animator().setFrame(frame, display: true)
        }
    }

    // MARK: - Polling

    private func startPolling() {
        stopPolling()
        updateTranscript()
        pollTimer = Timer.scheduledTimer(withTimeInterval: Self.pollInterval, repeats: true) { [weak self] _ in
            self?.updateTranscript()
        }
    }

    private func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func updateTranscript() {
        let text: String
        if let path = Self.currentOutputFile(), let content = try? String(contentsOfFile: path, encoding: .utf8) {
            text = Self.tailLines(from: content, maxLines: Self.scrollbackLines).joined(separator: "\n")
        } else {
            text = Self.placeholder
        }
        guard let textView = textView, let scrollView = scrollView else { return }
        let stickToBottom = isScrolledToBottom(scrollView)
        textView.string = text
        if stickToBottom {
            textView.scrollToEndOfDocument(nil)
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

    static func notchRect(on screen: NSScreen?) -> NSRect? {
        guard let screen = screen, screen.safeAreaInsets.top > 0,
              let left = screen.auxiliaryTopLeftArea,
              let right = screen.auxiliaryTopRightArea else { return nil }
        return NSRect(x: left.maxX, y: left.minY, width: right.minX - left.maxX, height: left.height)
    }

    static func currentOutputFile() -> String? {
        let lockPath = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".meet/sessions/active-recording.lock")
        guard let data = FileManager.default.contents(atPath: lockPath.path),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let outputFile = json["outputFile"] as? String else { return nil }
        return outputFile
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

    // Runnable check for the one piece of non-trivial logic here (no XCTest
    // target in this package). Invoked via `--self-test-notch` in main.swift.
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

        print("NotchPanelController.selfCheckTailExtraction: OK")
    }
}

// NSTrackingArea rebuilt on every bounds change (collapse <-> expand) via the
// AppKit-driven updateTrackingAreas() callback. Must be .activeAlways: the
// panel is never key, so the default .activeInKeyWindow silently never fires.
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
