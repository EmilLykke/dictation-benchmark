import Foundation

/// A reading from a monotonic clock, in nanoseconds from an arbitrary origin.
///
/// Every latency this bridge publishes is the difference between two stamps taken
/// seconds apart, and until 2026-09-04 both stamps came from `Date`, which is wall
/// clock: NTP steps it, and a step lands whole inside a clip's measured window with
/// nothing in the record to say it happened. `DispatchTime.now().uptimeNanoseconds`
/// cannot step or run backwards, so durations are stamped with it instead. The type
/// exists so the compiler stops a wall-clock `Date` being differenced by accident.
public struct MonotonicInstant: Comparable, Hashable, Sendable {
    public let uptimeNanoseconds: UInt64

    public init(uptimeNanoseconds: UInt64) {
        self.uptimeNanoseconds = uptimeNanoseconds
    }

    /// Milliseconds from `earlier` to this instant.
    ///
    /// Clamped at zero rather than wrapping: the arithmetic is unsigned, and a
    /// reversed pair would otherwise report about 18 million years and be published.
    public func milliseconds(since earlier: MonotonicInstant) -> Double {
        guard uptimeNanoseconds >= earlier.uptimeNanoseconds else { return 0 }
        return Double(uptimeNanoseconds - earlier.uptimeNanoseconds) / 1_000_000
    }

    public func advanced(byMilliseconds milliseconds: Double) -> MonotonicInstant {
        let delta = milliseconds * 1_000_000
        guard delta >= 0 else {
            let back = UInt64(-delta)
            return MonotonicInstant(
                uptimeNanoseconds: back > uptimeNanoseconds ? 0 : uptimeNanoseconds - back
            )
        }
        return MonotonicInstant(uptimeNanoseconds: uptimeNanoseconds + UInt64(delta))
    }

    public static func < (lhs: MonotonicInstant, rhs: MonotonicInstant) -> Bool {
        lhs.uptimeNanoseconds < rhs.uptimeNanoseconds
    }
}

/// The clock seam.
///
/// Production reads the machine's uptime clock; tests substitute a clock they drive
/// by hand, which is the only way to assert *where* in a sequence of key events a
/// stamp was taken without posting real key events at a real Wispr Flow.
public protocol MonotonicClock {
    func now() -> MonotonicInstant
}

public final class SystemMonotonicClock: MonotonicClock {
    public init() {}

    public func now() -> MonotonicInstant {
        MonotonicInstant(uptimeNanoseconds: DispatchTime.now().uptimeNanoseconds)
    }
}

/// Milliseconds from `start` to `end`, or `NSNull` when there is no end stamp.
///
/// Returns `Any` because it feeds `JSONSerialization`, which wants `NSNull` for a
/// JSON `null` and refuses a Swift `Optional`.
public func millisecondsOrNull(from start: MonotonicInstant, to end: MonotonicInstant?) -> Any {
    guard let end else { return NSNull() }
    return end.milliseconds(since: start)
}
