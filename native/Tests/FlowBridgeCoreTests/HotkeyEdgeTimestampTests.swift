import Foundation
import XCTest
@testable import FlowBridgeCore

/// Acceptance gate 8 of the benchmark contract: "Flow timestamp corresponds to the
/// exact Z keydown edge".
final class HotkeyEdgeTimestampTests: XCTestCase {
    /// The stamp is the clock reading at the Z key-down transition - not the reading
    /// after the chord has been posted and released, which is what the bridge used
    /// until 2026-09-04, and not the reading before Option went down either.
    func testStampIsTakenAtTheKeyDownTransition() throws {
        let clock = VirtualClock()
        let poster = RecordingPoster(
            clock: clock,
            advance: { clock.advance(milliseconds: $0) },
            // A deliberately slow modifier press. If the stamp were taken anywhere
            // but the key-down edge, half a second would move it.
            artificialModifierDelayMs: 500
        )

        let startOfCall = clock.now()
        let edge = try postHotkey(optionZ, poster: poster, clock: clock)
        let afterCall = clock.now()

        XCTAssertEqual(
            poster.posted.map(\.transition),
            [
                KeyTransition(role: .modifier, keyCode: 58, isKeyDown: true, flags: .maskAlternate),
                KeyTransition(role: .hotkey, keyCode: 6, isKeyDown: true, flags: .maskAlternate),
                KeyTransition(role: .hotkey, keyCode: 6, isKeyDown: false, flags: .maskAlternate),
                KeyTransition(role: .modifier, keyCode: 58, isKeyDown: false, flags: []),
            ],
            "Option must go down before Z, and come back up after it"
        )

        let keyDownStamp = try XCTUnwrap(poster.stamp(role: .hotkey, isKeyDown: true))
        XCTAssertEqual(
            edge.uptimeNanoseconds,
            keyDownStamp.uptimeNanoseconds,
            "startedAt/stoppedAt must equal the clock reading at the Z key-down event"
        )

        let modifierDownStamp = try XCTUnwrap(poster.stamp(role: .modifier, isKeyDown: true))
        XCTAssertGreaterThan(
            edge.uptimeNanoseconds,
            modifierDownStamp.uptimeNanoseconds,
            "The stamp is after the modifier press, not before it"
        )

        // The modifier press, its 500ms artificial delay and its 20ms settle wait all
        // sit before the stamp: harness setup, outside the measured window.
        XCTAssertEqual(edge.milliseconds(since: startOfCall), 520, accuracy: 0.001)

        // The 50ms key hold and the 20ms Option release sit after the stamp: they are
        // inside the measured window, where they belong. These are the milliseconds
        // the old post-return stamp dropped.
        XCTAssertEqual(afterCall.milliseconds(since: edge), 70, accuracy: 0.001)
    }

    /// Both edges are stamped by the same routine, so the rule cannot hold for the
    /// start hotkey and quietly fail for the stop hotkey.
    func testBothEdgesUseTheSameRule() throws {
        let clock = VirtualClock()

        func edgeOffsetFromCall() throws -> Double {
            let poster = RecordingPoster(clock: clock, advance: { clock.advance(milliseconds: $0) })
            let before = clock.now()
            let edge = try postHotkey(optionZ, poster: poster, clock: clock)
            let after = clock.now()
            XCTAssertEqual(after.milliseconds(since: edge), 70, accuracy: 0.001)
            return edge.milliseconds(since: before)
        }

        let start = try edgeOffsetFromCall()
        clock.advance(milliseconds: 4_000) // a clip plays
        let stop = try edgeOffsetFromCall()
        XCTAssertEqual(start, stop, accuracy: 0.001)
        XCTAssertEqual(start, 20, accuracy: 0.001, "One modifier settle wait, and nothing else")
    }

    /// The size of the defect, on the real clock with the real waits: how much of
    /// Flow's response window a stamp taken after `postHotkey` returns would drop.
    func testPostReturnStampWouldDropTheKeyHoldAndModifierRelease() throws {
        let clock = SystemMonotonicClock()
        let poster = SleepingPoster()

        let edge = try postHotkey(optionZ, poster: poster, clock: clock)
        let postReturnStamp = clock.now() // where the stamp used to be taken

        let dropped = postReturnStamp.milliseconds(since: edge)
        print("[timing] post-return stamp lands \(dropped)ms after the Z key-down edge")
        XCTAssertGreaterThan(dropped, 65, "50ms key hold + 20ms modifier release, minus scheduler slop")
        XCTAssertLessThan(dropped, 120, "If this fails the waits changed and the comments are stale")
    }
}

/// Posts nothing and sleeps for real, to measure what the waits around the key-down
/// edge actually cost on this machine without posting a key at Wispr Flow.
private final class SleepingPoster: HotkeyEventPoster {
    func assertCanPost() throws {}
    func post(_ transition: KeyTransition) throws {}
    func pause(seconds: Double) { Thread.sleep(forTimeInterval: seconds) }
}
