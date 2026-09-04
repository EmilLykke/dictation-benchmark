import CoreGraphics
import Foundation

public struct Hotkey: Decodable, Sendable {
    public let keyCode: UInt16
    public let modifiers: [String]

    public init(keyCode: UInt16, modifiers: [String]) {
        self.keyCode = keyCode
        self.modifiers = modifiers
    }
}

/// One synthetic keyboard transition, described rather than built.
///
/// The seam is here, one level above `CGEvent`, so a test can watch the order and
/// the timing of a hotkey without CoreGraphics, an Accessibility grant, or a
/// running Wispr Flow.
public struct KeyTransition: Equatable, Sendable {
    /// Which half of the chord this transition belongs to. The real poster needs it
    /// because the two halves set flags differently, and it is also what a test
    /// asserts against when it looks for the Z key-down edge.
    public enum Role: Sendable {
        case modifier
        case hotkey
    }

    public let role: Role
    public let keyCode: UInt16
    public let isKeyDown: Bool
    public let flags: CGEventFlags

    public init(role: Role, keyCode: UInt16, isKeyDown: Bool, flags: CGEventFlags) {
        self.role = role
        self.keyCode = keyCode
        self.isKeyDown = isKeyDown
        self.flags = flags
    }
}

public protocol HotkeyEventPoster {
    /// Throws before anything is posted if the process cannot post events at all.
    func assertCanPost() throws

    func post(_ transition: KeyTransition) throws

    /// The wait a real keyboard has between transitions. Part of the seam because
    /// the whole point of the `startedAt`/`stoppedAt` tests is that these waits sit
    /// *outside* the measured window.
    func pause(seconds: Double)
}

/// Waits between transitions, kept as named constants because they are the exact
/// intervals the timestamp fix is about: 70ms of them follow the Z key-down edge.
public enum HotkeyTiming {
    public static let modifierSettleSeconds = 0.02
    public static let keyHoldSeconds = 0.05
}

public enum HotkeyError: LocalizedError, Equatable {
    case accessibilityMissing
    case unknownModifier(String)
    case eventCreationFailed

    public var errorDescription: String? {
        switch self {
        case .accessibilityMissing: "Accessibility permission missing"
        case .unknownModifier(let name): "Unknown hotkey modifier: \(name)"
        case .eventCreationFailed: "Could not create keyboard event"
        }
    }
}

public func modifierKey(_ name: String) throws -> (keyCode: UInt16, flag: CGEventFlags) {
    switch name {
    case "command": (55, .maskCommand)
    case "control": (59, .maskControl)
    case "fn": (63, .maskSecondaryFn)
    case "option": (58, .maskAlternate)
    case "shift": (56, .maskShift)
    default: throw HotkeyError.unknownModifier(name)
    }
}

/// Posts `hotkey` and returns the instant of its **key-down edge** - the stamp the
/// benchmark's start and stop timestamps are taken from.
///
/// Until 2026-09-04 the caller stamped `stoppedAt` on the line after `post(hotkey)`
/// returned. Option+Z posts Option down, waits 20ms, posts Z down, holds 50ms,
/// posts Z up, then releases Option and waits another 20ms, so the stamp landed
/// 70ms of nominal waits - 81 to 90ms measured, scheduler slop included, by
/// `testPostReturnStampWouldDropTheKeyHoldAndModifierRelease` - after the edge that
/// actually stopped the dictation. The window opened late by that much, which is to
/// say that much of Flow's own response time was dropped from every
/// `stopToFirstTextMs` the harness recorded, in the direction that flatters the
/// product.
///
/// The stamp is now taken here, on the line before the key-down transition is handed
/// to the poster, with nothing between the two. `postHotkey` is used for both edges,
/// so start and stop are stamped by the same rule.
@discardableResult
public func postHotkey(
    _ hotkey: Hotkey,
    poster: HotkeyEventPoster,
    clock: MonotonicClock
) throws -> MonotonicInstant {
    try poster.assertCanPost()
    let modifiers = try hotkey.modifiers.map(modifierKey)

    var flags: CGEventFlags = []
    var held: [(keyCode: UInt16, flag: CGEventFlags)] = []

    /// Lets go of every modifier still down, in reverse order. Called on the way out
    /// of a throw as well as on success: a half-posted chord leaves the Option key
    /// stuck down for the whole rest of the run, which would corrupt every later clip
    /// rather than just this one.
    func releaseHeldModifiers() {
        for modifier in held.reversed() {
            flags.remove(modifier.flag)
            try? poster.post(
                KeyTransition(
                    role: .modifier,
                    keyCode: modifier.keyCode,
                    isKeyDown: false,
                    flags: flags
                )
            )
            poster.pause(seconds: HotkeyTiming.modifierSettleSeconds)
        }
        held.removeAll()
    }

    do {
        for modifier in modifiers {
            flags.insert(modifier.flag)
            try poster.post(
                KeyTransition(
                    role: .modifier,
                    keyCode: modifier.keyCode,
                    isKeyDown: true,
                    flags: flags
                )
            )
            held.append(modifier)
            poster.pause(seconds: HotkeyTiming.modifierSettleSeconds)
        }

        // The measured edge. Nothing may be inserted between this line and the post
        // below it, and nothing before it may be counted: the modifier presses and
        // their settle waits above are the harness setting up the chord, not the
        // product working.
        let keyDownAt = clock.now()
        try poster.post(
            KeyTransition(
                role: .hotkey,
                keyCode: hotkey.keyCode,
                isKeyDown: true,
                flags: flags
            )
        )

        poster.pause(seconds: HotkeyTiming.keyHoldSeconds)
        try poster.post(
            KeyTransition(
                role: .hotkey,
                keyCode: hotkey.keyCode,
                isKeyDown: false,
                flags: flags
            )
        )
        releaseHeldModifiers()
        return keyDownAt
    } catch {
        releaseHeldModifiers()
        throw error
    }
}

/// Posts transitions as real HID events.
public final class CGEventHotkeyPoster: HotkeyEventPoster {
    private let source = CGEventSource(stateID: .combinedSessionState)

    public init() {}

    public func assertCanPost() throws {
        guard CGPreflightPostEventAccess() else { throw HotkeyError.accessibilityMissing }
    }

    public func post(_ transition: KeyTransition) throws {
        guard let event = CGEvent(
            keyboardEventSource: source,
            virtualKey: transition.keyCode,
            keyDown: transition.isKeyDown
        ) else { throw HotkeyError.eventCreationFailed }

        switch transition.role {
        case .modifier:
            // Assigned, matching the pre-refactor code: a modifier event's flags are
            // exactly the set of modifiers held after this transition.
            event.flags = transition.flags
        case .hotkey:
            // Unioned, also matching the pre-refactor code: CoreGraphics puts its own
            // flags on a freshly created key event and clobbering them changes which
            // chord Flow sees.
            event.flags.formUnion(transition.flags)
        }
        event.post(tap: .cghidEventTap)
    }

    public func pause(seconds: Double) {
        Thread.sleep(forTimeInterval: seconds)
    }
}
