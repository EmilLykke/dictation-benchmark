import AppKit
import ApplicationServices
import AudioToolbox
import AVFoundation
import CoreAudio
import Foundation

private struct Hotkey: Decodable {
    let keyCode: UInt16
    let modifiers: [String]
}

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
        window.makeKeyAndOrderFront(nil)
        window.makeFirstResponder(textView)
        NSApp.activate(ignoringOtherApps: true)
    }

    func capturedText() -> String {
        textView.string
    }
}

private final class Bridge {
    static let shared = Bridge()
    weak var captureWindow: CaptureWindow?

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

        guard let outputDevice = audioDevices().first(where: { $0.name == deviceName }) else {
            throw BridgeError.audio("Audio device not found: \(deviceName)")
        }
        let previousOutput = try defaultOutputDevice()
        let switchedOutput = previousOutput != outputDevice.id
        var outputRestored = false
        if switchedOutput {
            try setDefaultOutputDevice(outputDevice.id)
            Thread.sleep(forTimeInterval: 0.5)
        }
        defer {
            if switchedOutput, !outputRestored {
                try? setDefaultOutputDevice(previousOutput)
            }
        }

        onMain { self.captureWindow?.focusAndClear() }
        Thread.sleep(forTimeInterval: 0.2)
        try post(hotkey)
        Thread.sleep(forTimeInterval: Double(leadMs) / 1_000)

        let playbackMs: Double
        do {
            playbackMs = try playAudio(path: audioPath)
        } catch {
            try? post(hotkey)
            return [
                "status": "failed",
                "transcript": "",
                "audioPlaybackMs": 0,
                "stopToFirstTextMs": NSNull(),
                "stopToStableTextMs": NSNull(),
                "diagnostic": error.localizedDescription,
            ]
        }

        Thread.sleep(forTimeInterval: Double(tailMs) / 1_000)
        try post(hotkey)
        let stoppedAt = Date()
        if switchedOutput {
            do {
                try setDefaultOutputDevice(previousOutput)
                outputRestored = true
            } catch {
                // Defer retries restoration before returning to caller.
            }
        }
        var firstTextAt: Date?
        var lastChangeAt: Date?
        var lastText = ""
        let deadline = stoppedAt.addingTimeInterval(Double(timeoutMs) / 1_000)

        while Date() < deadline {
            let text = onMain { self.captureWindow?.capturedText() ?? "" }
            let hasMeaningfulText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            if text != lastText {
                lastText = text
                lastChangeAt = Date()
                if hasMeaningfulText, firstTextAt == nil { firstTextAt = Date() }
            }
            if hasMeaningfulText,
               let changedAt = lastChangeAt,
               Date().timeIntervalSince(changedAt) * 1_000 >= Double(stableMs)
            {
                return [
                    "status": "ok",
                    "transcript": text,
                    "audioPlaybackMs": playbackMs,
                    "stopToFirstTextMs": milliseconds(from: stoppedAt, to: firstTextAt),
                    "stopToStableTextMs": milliseconds(from: stoppedAt, to: Date()),
                ]
            }
            Thread.sleep(forTimeInterval: 0.05)
        }

        return [
            "status": "timeout",
            "transcript": lastText,
            "audioPlaybackMs": playbackMs,
            "stopToFirstTextMs": milliseconds(from: stoppedAt, to: firstTextAt),
            "stopToStableTextMs": NSNull(),
            "diagnostic": lastText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "Flow did not paste text before timeout"
                : "Pasted text did not stabilize before timeout",
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
    let startedAt = Date()
    do {
        try player.run()
    } catch {
        throw BridgeError.audio("Could not start afplay: \(error.localizedDescription)")
    }
    player.waitUntilExit()
    guard player.terminationStatus == 0 else {
        throw BridgeError.audio("afplay failed with status \(player.terminationStatus): \(path)")
    }
    return Date().timeIntervalSince(startedAt) * 1_000
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

private func post(_ hotkey: Hotkey) throws {
    guard CGPreflightPostEventAccess() else {
        throw BridgeError.invalidRequest("Accessibility permission missing")
    }
    let source = CGEventSource(stateID: .combinedSessionState)
    let modifiers = try hotkey.modifiers.map(modifierKey)
    var flags: CGEventFlags = []
    var modifierUps: [(event: CGEvent, flag: CGEventFlags)] = []

    for modifier in modifiers {
        guard let down = CGEvent(
            keyboardEventSource: source,
            virtualKey: modifier.keyCode,
            keyDown: true
        ), let up = CGEvent(
            keyboardEventSource: source,
            virtualKey: modifier.keyCode,
            keyDown: false
        ) else { throw BridgeError.invalidRequest("Could not create modifier event") }
        flags.insert(modifier.flag)
        down.flags = flags
        down.post(tap: .cghidEventTap)
        modifierUps.append((up, modifier.flag))
        Thread.sleep(forTimeInterval: 0.02)
    }

    guard let down = CGEvent(keyboardEventSource: source, virtualKey: hotkey.keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: hotkey.keyCode, keyDown: false)
    else { throw BridgeError.invalidRequest("Could not create keyboard event") }
    down.flags.formUnion(flags)
    up.flags.formUnion(flags)
    down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.05)
    up.post(tap: .cghidEventTap)

    for modifier in modifierUps.reversed() {
        flags.remove(modifier.flag)
        modifier.event.flags = flags
        modifier.event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.02)
    }
}

private func modifierKey(_ name: String) throws -> (keyCode: UInt16, flag: CGEventFlags) {
    switch name {
    case "command": (55, .maskCommand)
    case "control": (59, .maskControl)
    case "fn": (63, .maskSecondaryFn)
    case "option": (58, .maskAlternate)
    case "shift": (56, .maskShift)
    default: throw BridgeError.invalidRequest("Unknown hotkey modifier: \(name)")
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

private func milliseconds(from start: Date, to end: Date?) -> Any {
    guard let end else { return NSNull() }
    return end.timeIntervalSince(start) * 1_000
}

private let app = NSApplication.shared
private let delegate = CaptureWindow()
Bridge.shared.captureWindow = delegate
app.delegate = delegate
app.run()
