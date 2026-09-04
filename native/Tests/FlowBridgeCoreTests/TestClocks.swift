import CoreGraphics
import Foundation
import XCTest
@testable import FlowBridgeCore

/// A clock the test moves by hand, so "when was this stamp taken" has an exact
/// answer instead of a tolerance.
final class VirtualClock: MonotonicClock {
    private var nanoseconds: UInt64 = 1_000_000_000

    func now() -> MonotonicInstant {
        MonotonicInstant(uptimeNanoseconds: nanoseconds)
    }

    func advance(milliseconds: Double) {
        nanoseconds += UInt64(milliseconds * 1_000_000)
    }
}

/// Stands in for CoreGraphics. Records every transition with the clock reading at
/// the moment it was handed over, which is what lets a test say *where* in the
/// sequence the hotkey stamp was taken rather than merely that it looks plausible.
final class RecordingPoster: HotkeyEventPoster {
    struct Posted {
        let transition: KeyTransition
        let at: MonotonicInstant
    }

    private let clock: MonotonicClock
    private let advance: (Double) -> Void

    /// Extra delay injected after each modifier transition. The point of the
    /// exercise: a slow chord must not shorten the measured window.
    private let artificialModifierDelayMs: Double

    private(set) var posted: [Posted] = []

    init(
        clock: MonotonicClock,
        advance: @escaping (Double) -> Void,
        artificialModifierDelayMs: Double = 0
    ) {
        self.clock = clock
        self.advance = advance
        self.artificialModifierDelayMs = artificialModifierDelayMs
    }

    func assertCanPost() throws {}

    func post(_ transition: KeyTransition) throws {
        posted.append(Posted(transition: transition, at: clock.now()))
        if transition.role == .modifier, transition.isKeyDown, artificialModifierDelayMs > 0 {
            advance(artificialModifierDelayMs)
        }
    }

    func pause(seconds: Double) {
        advance(seconds * 1_000)
    }

    func stamp(role: KeyTransition.Role, isKeyDown: Bool) -> MonotonicInstant? {
        posted.first { $0.transition.role == role && $0.transition.isKeyDown == isKeyDown }?.at
    }
}

/// Option+Z, the configured Wispr Flow shortcut. 6 is the Z key.
let optionZ = Hotkey(keyCode: 6, modifiers: ["option"])
