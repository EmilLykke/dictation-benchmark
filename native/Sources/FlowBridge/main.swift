import AppKit
import ApplicationServices
import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation
import FlowBridgeCore

/// One clock for the whole bridge, monotonic, shared so that a stamp taken in the
/// text-change notification is comparable with a stamp taken at a hotkey edge.
private let sharedClock = SystemMonotonicClock()

private struct Request: Decodable {
    let id: Int
    let command: String
    let deviceName: String?
    let audioPath: String?
    let hotkey: Hotkey?
    let leadMs: Int?
    let tailMs: Int?
    let timeoutMs: Int?
    let stableMs: Int?
    let pollIntervalMs: Int?
}

private enum BridgeError: LocalizedError {
    case invalidRequest(String)
    case audio(String)

    var errorDescription: String? {
        switch self {
        case .invalidRequest(let message), .audio(let message): message
        }
    }
}

private final class CaptureWindow: NSObject, NSApplicationDelegate {
    private(set) var window: NSWindow!
    private(set) var textView: NSTextView!

    /// Where the event-based end of the response window comes from.
    private let textChanges = TextChangeLog()

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMainMenu()

        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 760, height: 320))
        scrollView.hasVerticalScroller = true
        textView = NSTextView(frame: scrollView.bounds)
        textView.isEditable = true
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.isContinuousSpellCheckingEnabled = false
        textView.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
        scrollView.documentView = textView

        // The receiver window is this process's own `NSTextView`, so the text-change
        // signal the benchmark wants is available in-process and does not need
        // Accessibility at all: `NSTextStorage` posts this notification at the end of
        // every edit that changes characters, whichever route the edit arrived by -
        // Flow's synthetic Cmd+V, or an AX `setValue` on the text area, which AppKit
        // implements by mutating this same text storage.
        //
        // An `AXObserver` on `kAXValueChangedNotification` was the alternative and is
        // strictly worse here: observing your own process over AX means an
        // `AXUIElementCreateApplication(getpid())` round trip through the
        // accessibility server for a signal already being posted locally, it adds a
        // second trust dependency to a harness that already fails preflight often
        // enough on the first one, and `AXTextArea` value-changed arrives *after* the
        // same edit that posts this notification. The AX path is what a harness would
        // need if the receiver belonged to another application; it does not.
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(receiverTextStorageDidChange(_:)),
            name: NSTextStorage.didProcessEditingNotification,
            object: textView.textStorage
        )

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 320),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Dictation Benchmark Receiver"
        window.contentView = scrollView
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(textView)
        NSApp.activate(ignoringOtherApps: true)

        DispatchQueue.global(qos: .userInitiated).async {
            Bridge.shared.readRequests()
        }
    }

    /// Stamps the change itself, rather than the poll that later notices it.
    ///
    /// Runs on whichever thread performed the edit, which for an `NSTextView` is the
    /// main thread - the same thread the bridge reads the log from through `onMain`,
    /// which is what keeps `TextChangeLog` safe without a lock.
    @objc private func receiverTextStorageDidChange(_ notification: Notification) {
        guard let storage = notification.object as? NSTextStorage,
              storage.editedMask.contains(.editedCharacters)
        else { return }
        textChanges.record(text: storage.string, at: sharedClock.now())
    }

    private func installMainMenu() {
        let mainMenu = NSMenu()

        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu(title: "Dictation Benchmark Receiver")
        appMenu.addItem(
            withTitle: "Quit Dictation Benchmark Receiver",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        NSApp.mainMenu = mainMenu
    }

    func focusAndClear() {
        textView.string = ""
        // Cleared here, before the start hotkey, so the reset is outside both measured
        // edges and the log holds exactly one clip's changes.
        textChanges.reset()
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(textView)
        NSApp.activate(ignoringOtherApps: true)
    }

    func textChangeSnapshot(since windowOpenedAt: MonotonicInstant) -> TextChangeSnapshot {
        textChanges.snapshot(since: windowOpenedAt, liveText: textView.string)
    }
}

private final class Bridge {
    static let shared = Bridge()
    weak var captureWindow: CaptureWindow?

    private let clock: MonotonicClock = sharedClock
    private let poster: HotkeyEventPoster = CGEventHotkeyPoster()

    func readRequests() {
        while let line = readLine() {
            guard let data = line.data(using: .utf8) else { continue }
            do {
                let request = try JSONDecoder().decode(Request.self, from: data)
                try handle(request)
                if request.command == "quit" { return }
            } catch {
                let id = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"] as? Int ?? -1
                respond(id: id, error: error.localizedDescription)
            }
        }
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    private func handle(_ request: Request) throws {
        switch request.command {
        case "metadata":
            let product = flowApplication()
            respond(id: request.id, result: [
                "running": product != nil,
                "version": (product?.version as Any?) ?? NSNull(),
            ])

        case "preflight":
            let expectedDevice = try require(request.deviceName, "deviceName")
            let devices = audioDevices()
            respond(id: request.id, result: [
                "accessibilityTrusted": CGPreflightPostEventAccess(),
                "productRunning": flowApplication() != nil,
                "outputDeviceFound": devices.contains { $0.name == expectedDevice },
                "outputDevices": devices.map(\.name),
            ])

        case "transcribe":
            let result = try transcribe(request)
            respond(id: request.id, result: result)

        case "quit":
            respond(id: request.id, result: [:])
            DispatchQueue.main.async { NSApp.terminate(nil) }

        default:
            throw BridgeError.invalidRequest("Unknown command: \(request.command)")
        }
    }

    private func transcribe(_ request: Request) throws -> [String: Any] {
        let audioPath = try require(request.audioPath, "audioPath")
        let deviceName = try require(request.deviceName, "deviceName")
        let hotkey = try require(request.hotkey, "hotkey")
        let leadMs = try require(request.leadMs, "leadMs")
        let tailMs = try require(request.tailMs, "tailMs")
        let timeoutMs = try require(request.timeoutMs, "timeoutMs")
        let stableMs = try require(request.stableMs, "stableMs")
        let pollIntervalMs = try require(request.pollIntervalMs, "pollIntervalMs")

        guard let outputDevice = audioDevices().first(where: { $0.name == deviceName }) else {
            throw BridgeError.audio("Audio device not found: \(deviceName)")
        }
        let previousOutput = try defaultOutputDevice()
        let switchedOutput = previousOutput != outputDevice.id
        var outputRestored = false
        var outputDeviceRestoreMs: Double?
        if switchedOutput {
            try setDefaultOutputDevice(outputDevice.id)
            Thread.sleep(forTimeInterval: 0.5)
        }

        /// Puts the user's own output device back, and records what Core Audio charged
        /// for it.
        ///
        /// Called on every return path, which is to say *after* the response window has
        /// closed. Until 2026-09-04 this ran on the line after the stop hotkey, inside
        /// the window: `setDefaultOutputDevice` is synchronous and blocks while the HAL
        /// reconfigures, so it put a floor of roughly 300ms under every
        /// `stopToFirstTextMs` this harness had ever recorded, flat against clip length.
        ///
        /// The window was moved rather than the stamp. `stoppedAt` has to keep meaning
        /// "the instant the stop hotkey was delivered" - stamping it after the restore
        /// would have produced the same clean number by quietly redefining the thing
        /// being measured, and nothing about the device switch belongs to the product.
        func restoreOutputDevice() {
            guard switchedOutput, !outputRestored else { return }
            let startedAt = clock.now()
            do {
                try setDefaultOutputDevice(previousOutput)
                outputRestored = true
                outputDeviceRestoreMs = clock.now().milliseconds(since: startedAt)
            } catch {
                // Left unrestored on purpose: the defer below retries before returning.
            }
        }
        defer {
            if switchedOutput, !outputRestored {
                try? setDefaultOutputDevice(previousOutput)
            }
        }

        onMain { self.captureWindow?.focusAndClear() }
        Thread.sleep(forTimeInterval: 0.2)

        // Both edges are stamped inside `postHotkey`, on the Z key-down transition.
        // Before 2026-09-04 the stop edge was stamped after the whole chord had been
        // posted and released - 70ms of nominal waits, 81 to 90ms measured on this
        // machine by `testPostReturnStampWouldDropTheKeyHoldAndModifierRelease` - and
        // that much of Flow's response was dropped from every record. See `postHotkey`.
        let startedAt = try postHotkey(hotkey, poster: poster, clock: clock)

        // Lead and tail padding, playback, and everything else the harness does to feed
        // Flow the clip all sit between the two edges, before the stop stamp is taken.
        Thread.sleep(forTimeInterval: Double(leadMs) / 1_000)

        let playbackMs: Double
        do {
            playbackMs = try playAudio(path: audioPath)
        } catch {
            let abortedStopAt = try? postHotkey(hotkey, poster: poster, clock: clock)
            restoreOutputDevice()
            var failure = timingFields(
                startedAt: startedAt,
                stoppedAt: abortedStopAt,
                stableMs: stableMs,
                pollIntervalMs: pollIntervalMs,
                observation: nil,
                outputDeviceRestoreMs: outputDeviceRestoreMs
            )
            failure["status"] = "failed"
            failure["transcript"] = ""
            failure["audioPlaybackMs"] = 0
            failure["diagnostic"] = error.localizedDescription
            return failure
        }

        Thread.sleep(forTimeInterval: Double(tailMs) / 1_000)

        // `stoppedAt` is the Z key-down edge of the stop chord, taken inside
        // `postHotkey`; the 50ms key hold and the 20ms Option release that follow it
        // are Flow's response time, not the harness's, and are now inside the window
        // where they belong.
        let stoppedAt = try postHotkey(hotkey, poster: poster, clock: clock)

        let observation = observeResponseWindow(
            openedAt: stoppedAt,
            settings: ResponseWindowSettings(
                stableMs: stableMs,
                timeoutMs: timeoutMs,
                pollIntervalMs: pollIntervalMs
            ),
            clock: clock,
            sleep: { Thread.sleep(forTimeInterval: $0) },
            readSnapshot: { windowOpenedAt in
                onMain { self.captureWindow?.textChangeSnapshot(since: windowOpenedAt) ?? .empty }
            }
        )

        restoreOutputDevice()

        var result = timingFields(
            startedAt: startedAt,
            stoppedAt: stoppedAt,
            stableMs: stableMs,
            pollIntervalMs: pollIntervalMs,
            observation: observation,
            outputDeviceRestoreMs: outputDeviceRestoreMs
        )
        result["transcript"] = observation.text
        result["audioPlaybackMs"] = playbackMs
        switch observation.outcome {
        case .stable:
            result["status"] = "ok"
        case .timedOut:
            result["status"] = "timeout"
            result["diagnostic"] = observation.text
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Flow did not paste text before timeout"
                : "Pasted text did not stabilize before timeout"
        }
        return result
    }

    /// The timing half of a `transcribe` reply, in one place so the ok, timeout and
    /// failed paths cannot drift apart on which fields they carry.
    ///
    /// `stopToLastTextChangeMs` is the response metric named by the benchmark
    /// contract: stop key-down edge to the last actual change in the pasted text. It
    /// is a raw stamp with nothing subtracted from it - the 750ms stability
    /// confirmation happens *after* the instant it records, so the delay was never in
    /// it. `stopToStableTextMs` is the older number and does contain that delay plus
    /// up to one poll interval of noticing it; it stays for continuity with runs
    /// before 2026-09-04 and must not be read as a response time.
    private func timingFields(
        startedAt: MonotonicInstant,
        stoppedAt: MonotonicInstant?,
        stableMs: Int,
        pollIntervalMs: Int,
        observation: ResponseWindowObservation?,
        outputDeviceRestoreMs: Double?
    ) -> [String: Any] {
        let source = observation?.source
        return [
            "startToStopMs": stoppedAt.map { $0.milliseconds(since: startedAt) } as Any? ?? NSNull(),
            "stopToFirstTextMs": stoppedAt.flatMap { stop in
                observation.map { millisecondsOrNull(from: stop, to: $0.firstMeaningfulTextAt) }
            } ?? NSNull(),
            "stopToLastTextChangeMs": stoppedAt.flatMap { stop in
                observation.map { millisecondsOrNull(from: stop, to: $0.lastTextChangeAt) }
            } ?? NSNull(),
            "stopToStableTextMs": stoppedAt.flatMap { stop in
                observation.map { millisecondsOrNull(from: stop, to: $0.stabilityConfirmedAt) }
            } ?? NSNull(),
            "stabilityDelayMs": Double(stableMs),
            "textChangeSource": source?.rawValue as Any? ?? NSNull(),
            "textChangeCount": observation?.changeCount as Any? ?? NSNull(),
            // Stated bias on the change stamps: zero on the event path because the
            // notification stamps the change itself, one whole poll interval of
            // worst case on the fallback path because there the stamp is the poll.
            "textChangeBiasMs": source == nil ? NSNull() : (source == .poll ? Double(pollIntervalMs) : 0),
            "stopToFirstTextHarnessMs": observation.flatMap {
                $0.firstMeaningfulTextAt == nil ? nil : $0.harnessReadMsBeforeFirstText
            } as Any? ?? NSNull(),
            "outputDeviceRestoreMs": outputDeviceRestoreMs as Any? ?? NSNull(),
            // Provenance, so a pooled figure can tell a post-fix clip from a pre-fix
            // one without consulting a run date: monotonic clock, and both edges
            // stamped at the hotkey's key-down transition.
            "timingClock": "monotonic",
            "hotkeyEdge": "keydown",
        ]
    }

    private func respond(id: Int, result: [String: Any]) {
        writeJSON(["id": id, "ok": true, "result": result])
    }

    private func respond(id: Int, error: String) {
        writeJSON(["id": id, "ok": false, "error": error])
    }

    private func writeJSON(_ object: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object),
              var line = String(data: data, encoding: .utf8)
        else { return }
        line += "\n"
        FileHandle.standardOutput.write(Data(line.utf8))
    }
}

private struct AudioDevice {
    let id: AudioDeviceID
    let name: String
}

private func audioDevices() -> [AudioDevice] {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size
    ) == noErr else { return [] }

    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    guard count > 0 else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: count)
    let status = ids.withUnsafeMutableBytes { bytes in
        AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            bytes.baseAddress!
        )
    }
    guard status == noErr else { return [] }
    return ids.compactMap { id in
        guard deviceHasOutput(id), let name = deviceName(id) else { return nil }
        return AudioDevice(id: id, name: name)
    }
}

private func deviceHasOutput(_ id: AudioDeviceID) -> Bool {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyStreamConfiguration,
        mScope: kAudioDevicePropertyScopeOutput,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr,
          size >= MemoryLayout<AudioBufferList>.size
    else { return false }

    let raw = UnsafeMutableRawPointer.allocate(
        byteCount: Int(size),
        alignment: MemoryLayout<AudioBufferList>.alignment
    )
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, raw) == noErr else { return false }
    let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
    return UnsafeMutableAudioBufferListPointer(list).contains { $0.mNumberChannels > 0 }
}

private func deviceName(_ id: AudioDeviceID) -> String? {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var name: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr,
          let value = name?.takeUnretainedValue()
    else { return nil }
    return value as String
}

private func playAudio(path: String) throws -> Double {
    let player = Process()
    player.executableURL = URL(fileURLWithPath: "/usr/bin/afplay")
    player.arguments = [path]
    let startedAt = sharedClock.now()
    do {
        try player.run()
    } catch {
        throw BridgeError.audio("Could not start afplay: \(error.localizedDescription)")
    }
    player.waitUntilExit()
    guard player.terminationStatus == 0 else {
        throw BridgeError.audio("afplay failed with status \(player.terminationStatus): \(path)")
    }
    return sharedClock.now().milliseconds(since: startedAt)
}

private func defaultOutputDevice() throws -> AudioDeviceID {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var device = AudioDeviceID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device
    )
    guard status == noErr, device != kAudioObjectUnknown else {
        throw BridgeError.audio("Could not read default output device (Core Audio status \(status))")
    }
    return device
}

private func setDefaultOutputDevice(_ device: AudioDeviceID) throws {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultOutputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var mutableDevice = device
    let status = AudioObjectSetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        UInt32(MemoryLayout<AudioDeviceID>.size),
        &mutableDevice
    )
    guard status == noErr else {
        throw BridgeError.audio("Could not set default output device (Core Audio status \(status))")
    }
}

private func flowApplication() -> (application: NSRunningApplication, version: String?)? {
    onMain {
        guard let app = NSWorkspace.shared.runningApplications.first(where: {
            let name = $0.localizedName?.lowercased() ?? ""
            let bundle = $0.bundleIdentifier?.lowercased() ?? ""
            return name.contains("wispr flow") || bundle.contains("wispr")
        }) else { return nil }
        let version = app.bundleURL
            .flatMap(Bundle.init(url:))?
            .object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return (app, version)
    }
}

private func onMain<T>(_ work: @escaping () -> T) -> T {
    if Thread.isMainThread { return work() }
    return DispatchQueue.main.sync(execute: work)
}

private func require<T>(_ value: T?, _ name: String) throws -> T {
    guard let value else { throw BridgeError.invalidRequest("Missing \(name)") }
    return value
}

private let app = NSApplication.shared
private let delegate = CaptureWindow()
Bridge.shared.captureWindow = delegate
app.delegate = delegate
app.run()
