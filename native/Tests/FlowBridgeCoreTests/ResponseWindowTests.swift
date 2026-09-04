import Foundation
import XCTest
@testable import FlowBridgeCore

/// Acceptance gate 9 of the benchmark contract: "The 750 ms stability delay does not
/// enter the Flow response metric".
final class ResponseWindowTests: XCTestCase {
    private let settings = ResponseWindowSettings(stableMs: 750, timeoutMs: 30_000, pollIntervalMs: 10)

    /// Flow pastes at +300ms and corrects itself at +500ms; the harness then waits
    /// 750ms to be sure nothing else is coming. The response metric is 500ms.
    func testStabilityDelayStaysOutOfTheResponseMetric() {
        let clock = VirtualClock()
        let stoppedAt = clock.now()
        let firstChangeAt = stoppedAt.advanced(byMilliseconds: 300)
        let lastChangeAt = stoppedAt.advanced(byMilliseconds: 500)

        let observation = observeResponseWindow(
            openedAt: stoppedAt,
            settings: settings,
            clock: clock,
            sleep: { clock.advance(milliseconds: $0 * 1_000) },
            readSnapshot: { _ in
                let elapsed = clock.now().milliseconds(since: stoppedAt)
                if elapsed >= 500 {
                    return TextChangeSnapshot(
                        text: "hello there world",
                        changeCount: 2,
                        firstMeaningfulChangeAt: firstChangeAt,
                        lastChangeAt: lastChangeAt
                    )
                }
                if elapsed >= 300 {
                    return TextChangeSnapshot(
                        text: "hello there",
                        changeCount: 1,
                        firstMeaningfulChangeAt: firstChangeAt,
                        lastChangeAt: firstChangeAt
                    )
                }
                return .empty
            }
        )

        XCTAssertEqual(observation.outcome, .stable)
        XCTAssertEqual(observation.source, .event)
        XCTAssertEqual(observation.changeCount, 2)

        let responseMs = observation.lastTextChangeAt!.milliseconds(since: stoppedAt)
        XCTAssertEqual(responseMs, 500, accuracy: 0.001, "The last actual pasted-text change, raw")
        XCTAssertEqual(
            observation.firstMeaningfulTextAt!.milliseconds(since: stoppedAt),
            300,
            accuracy: 0.001
        )

        // The published `stopToStableTextMs` still contains the delay, which is why it
        // is not the response metric: it is at least 750ms bigger than the number that
        // is.
        let stableMs = observation.stabilityConfirmedAt!.milliseconds(since: stoppedAt)
        XCTAssertGreaterThanOrEqual(stableMs - responseMs, 750)
        XCTAssertLessThan(responseMs, stableMs)
        XCTAssertLessThanOrEqual(
            stableMs - responseMs,
            750 + Double(settings.pollIntervalMs),
            "Confirmation costs the delay plus at most one poll of noticing"
        )
    }

    /// The same guarantee on the fallback path: no change notifications at all, so the
    /// stamp is a poll, biased by at most one interval - and still not the stable
    /// stamp.
    func testPollFallbackStampsTheLastChangeAndStatesItsBias() {
        let clock = VirtualClock()
        let stoppedAt = clock.now()

        let observation = observeResponseWindow(
            openedAt: stoppedAt,
            settings: settings,
            clock: clock,
            sleep: { clock.advance(milliseconds: $0 * 1_000) },
            readSnapshot: { _ in
                let elapsed = clock.now().milliseconds(since: stoppedAt)
                return TextChangeSnapshot(
                    text: elapsed >= 500 ? "hello there world" : (elapsed >= 300 ? "hello there" : ""),
                    changeCount: 0,
                    firstMeaningfulChangeAt: nil,
                    lastChangeAt: nil
                )
            }
        )

        XCTAssertEqual(observation.outcome, .stable)
        XCTAssertEqual(observation.source, .poll, "No notification arrived, so the record must say poll")

        let responseMs = observation.lastTextChangeAt!.milliseconds(since: stoppedAt)
        XCTAssertGreaterThanOrEqual(responseMs, 500)
        XCTAssertLessThanOrEqual(
            responseMs,
            500 + Double(settings.pollIntervalMs),
            "A polled stamp is late by at most one interval; that is the stated bias"
        )
        let stableMs = observation.stabilityConfirmedAt!.milliseconds(since: stoppedAt)
        XCTAssertGreaterThanOrEqual(stableMs - responseMs, 750)
    }

    func testTimeoutKeepsTheLastObservedChange() {
        let clock = VirtualClock()
        let stoppedAt = clock.now()
        let lastChangeAt = stoppedAt.advanced(byMilliseconds: 400)

        let observation = observeResponseWindow(
            openedAt: stoppedAt,
            settings: ResponseWindowSettings(stableMs: 750, timeoutMs: 1_000, pollIntervalMs: 10),
            clock: clock,
            sleep: { clock.advance(milliseconds: $0 * 1_000) },
            readSnapshot: { _ in
                let elapsed = clock.now().milliseconds(since: stoppedAt)
                // Text keeps arriving, so stability is never reached before the timeout.
                return TextChangeSnapshot(
                    text: "partial \(Int(elapsed / 100))",
                    changeCount: 1,
                    firstMeaningfulChangeAt: elapsed >= 400 ? lastChangeAt : nil,
                    lastChangeAt: elapsed >= 400 ? lastChangeAt : nil
                )
            }
        )

        XCTAssertEqual(observation.outcome, .timedOut)
        XCTAssertNil(observation.stabilityConfirmedAt, "There is no stable stamp on a timeout")
        XCTAssertEqual(observation.source, .poll)
        XCTAssertGreaterThan(
            observation.lastTextChangeAt!.milliseconds(since: stoppedAt),
            400,
            "Live text kept changing after the event stream stalled"
        )
    }

    func testNewerPolledChangeWinsAfterEventNotificationsStop() {
        let clock = VirtualClock()
        let stoppedAt = clock.now()
        let eventAt = stoppedAt.advanced(byMilliseconds: 300)

        let observation = observeResponseWindow(
            openedAt: stoppedAt,
            settings: settings,
            clock: clock,
            sleep: { clock.advance(milliseconds: $0 * 1_000) },
            readSnapshot: { _ in
                let elapsed = clock.now().milliseconds(since: stoppedAt)
                return TextChangeSnapshot(
                    text: elapsed >= 500 ? "hello there world" : (elapsed >= 300 ? "hello there" : ""),
                    changeCount: elapsed >= 300 ? 1 : 0,
                    firstMeaningfulChangeAt: elapsed >= 300 ? eventAt : nil,
                    // Notification path stalls after first paste. Poll still sees correction.
                    lastChangeAt: elapsed >= 300 ? eventAt : nil
                )
            }
        )

        XCTAssertEqual(observation.outcome, .stable)
        XCTAssertEqual(observation.source, .poll)
        XCTAssertGreaterThanOrEqual(
            observation.lastTextChangeAt!.milliseconds(since: stoppedAt),
            500
        )
    }
}

final class TextChangeLogTests: XCTestCase {
    func testChangesBeforeTheWindowOpenedAreExcluded() {
        let clock = VirtualClock()
        let log = TextChangeLog()

        log.record(text: "", at: clock.now())          // the clear, before the start hotkey
        clock.advance(milliseconds: 100)
        log.record(text: "stale", at: clock.now())     // something that landed pre-stop
        clock.advance(milliseconds: 100)
        let stoppedAt = clock.now()
        clock.advance(milliseconds: 250)
        log.record(text: "stale hello", at: clock.now())

        let snapshot = log.snapshot(since: stoppedAt, liveText: "stale hello")
        XCTAssertEqual(snapshot.changeCount, 1)
        XCTAssertEqual(snapshot.lastChangeAt!.milliseconds(since: stoppedAt), 250, accuracy: 0.001)
    }

    func testIdenticalTextIsNotAChange() {
        let clock = VirtualClock()
        let log = TextChangeLog()
        let stoppedAt = clock.now()

        log.record(text: "hello", at: clock.now())
        clock.advance(milliseconds: 200)
        log.record(text: "hello", at: clock.now()) // attribute-only edit: not a paste

        let snapshot = log.snapshot(since: stoppedAt, liveText: "hello")
        XCTAssertEqual(snapshot.changeCount, 1)
        XCTAssertEqual(snapshot.lastChangeAt!.milliseconds(since: stoppedAt), 0, accuracy: 0.001)
    }

    func testResetDropsThePreviousClip() {
        let clock = VirtualClock()
        let log = TextChangeLog()
        log.record(text: "previous clip", at: clock.now())
        log.reset()
        let snapshot = log.snapshot(since: MonotonicInstant(uptimeNanoseconds: 0), liveText: "")
        XCTAssertEqual(snapshot.changeCount, 0)
        XCTAssertNil(snapshot.lastChangeAt)
    }
}
