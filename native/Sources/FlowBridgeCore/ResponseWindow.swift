import Foundation

/// Which signal produced the text-change stamps in a clip's record.
///
/// `event` means the receiver window's own text storage said when it changed, so
/// the stamp carries no discovery bias. `poll` means the notification never
/// arrived and the stamp is only as precise as the poll interval, which the record
/// then has to state.
public enum TextChangeSource: String, Sendable {
    case event
    case poll
}

/// What the receiver window looks like at one read.
public struct TextChangeSnapshot: Sendable {
    /// The window's text, read live from the view rather than from the change log.
    ///
    /// Read live on purpose: it is what keeps the poll fallback honest. If the
    /// change notification silently stops arriving, the log goes empty but this
    /// stays right, and the clip degrades to poll precision instead of timing out.
    public let text: String

    /// Changes observed at or after the stop edge. Zero means the event path had
    /// nothing to say about this window.
    public let changeCount: Int
    public let firstMeaningfulChangeAt: MonotonicInstant?
    public let lastChangeAt: MonotonicInstant?

    public init(
        text: String,
        changeCount: Int,
        firstMeaningfulChangeAt: MonotonicInstant?,
        lastChangeAt: MonotonicInstant?
    ) {
        self.text = text
        self.changeCount = changeCount
        self.firstMeaningfulChangeAt = firstMeaningfulChangeAt
        self.lastChangeAt = lastChangeAt
    }

    public static let empty = TextChangeSnapshot(
        text: "",
        changeCount: 0,
        firstMeaningfulChangeAt: nil,
        lastChangeAt: nil
    )
}

public struct ResponseWindowSettings: Sendable {
    /// How long the text has to stop changing before the paste is called finished.
    /// 750ms in every run so far. Confirmation only - it is deliberately kept out
    /// of the response metric.
    public let stableMs: Int
    public let timeoutMs: Int
    public let pollIntervalMs: Int

    public init(stableMs: Int, timeoutMs: Int, pollIntervalMs: Int) {
        self.stableMs = stableMs
        self.timeoutMs = timeoutMs
        self.pollIntervalMs = pollIntervalMs
    }
}

public struct ResponseWindowObservation: Sendable {
    public enum Outcome: String, Sendable {
        case stable
        case timedOut
    }

    public let outcome: Outcome
    public let text: String
    public let firstMeaningfulTextAt: MonotonicInstant?

    /// The last time the pasted text actually changed. This is the end of the
    /// response window, and it is a raw stamp: the stability delay is after it, not
    /// inside it, so nothing has to be subtracted to remove the delay.
    public let lastTextChangeAt: MonotonicInstant?

    /// When the run decided the text had stopped changing, i.e. `lastTextChangeAt`
    /// plus the whole stability delay plus up to one poll interval of noticing.
    /// Reported for continuity with the old `stopToStableTextMs` and never used as
    /// the response metric.
    public let stabilityConfirmedAt: MonotonicInstant?

    public let source: TextChangeSource
    public let changeCount: Int
    public let harnessReadMsBeforeFirstText: Double
}

private func hasMeaningfulText(_ text: String) -> Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

/// Watches the receiver window from the stop edge until the pasted text stops
/// changing, and reports when it last changed.
///
/// The loop still runs on a timer because something has to notice that 750ms have
/// passed with no further change, and has to notice a timeout. But what it reports
/// is the change stamp taken by the text-storage notification, not the time the
/// loop happened to look: with `source == .event` the poll interval affects only how
/// quickly stability is *declared*, never the response metric itself.
///
/// `sleep` and `readSnapshot` are parameters so a test can drive a whole window,
/// including the 750ms delay, against a hand-driven clock with no AppKit in sight.
public func observeResponseWindow(
    openedAt stoppedAt: MonotonicInstant,
    settings: ResponseWindowSettings,
    clock: MonotonicClock,
    sleep: (Double) -> Void,
    readSnapshot: (MonotonicInstant) -> TextChangeSnapshot
) -> ResponseWindowObservation {
    let deadline = stoppedAt.advanced(byMilliseconds: Double(settings.timeoutMs))

    var pollLastChangeAt: MonotonicInstant?
    var pollFirstTextAt: MonotonicInstant?
    var polledChangeCount = 0
    var lastPolledText = ""
    var latestSnapshot = TextChangeSnapshot.empty
    var harnessReadMs = 0.0
    var sawFirstText = false

    while clock.now() < deadline {
        let readStartedAt = clock.now()
        let snapshot = readSnapshot(stoppedAt)
        latestSnapshot = snapshot
        if !sawFirstText {
            // The harness's own share of `stopToFirstTextMs`: the hop to the main
            // thread to read the window, summed over the polls up to and including
            // the one that first saw text.
            harnessReadMs += clock.now().milliseconds(since: readStartedAt)
        }

        let textIsMeaningful = hasMeaningfulText(snapshot.text)
        if snapshot.text != lastPolledText {
            lastPolledText = snapshot.text
            polledChangeCount += 1
            let noticedAt = clock.now()
            pollLastChangeAt = noticedAt
            if textIsMeaningful, pollFirstTextAt == nil { pollFirstTextAt = noticedAt }
        }

        // Event stamps win whenever there are any. They are earlier and truer: a
        // polled stamp is the change plus however long it sat unnoticed.
        let source: TextChangeSource = snapshot.lastChangeAt == nil ? .poll : .event
        let lastChangeAt = snapshot.lastChangeAt ?? pollLastChangeAt
        let firstTextAt = snapshot.firstMeaningfulChangeAt ?? pollFirstTextAt
        if firstTextAt != nil { sawFirstText = true }

        if textIsMeaningful,
           let changedAt = lastChangeAt,
           clock.now().milliseconds(since: changedAt) >= Double(settings.stableMs)
        {
            return ResponseWindowObservation(
                outcome: .stable,
                text: snapshot.text,
                firstMeaningfulTextAt: firstTextAt,
                lastTextChangeAt: lastChangeAt,
                stabilityConfirmedAt: clock.now(),
                source: source,
                changeCount: source == .event ? snapshot.changeCount : polledChangeCount,
                harnessReadMsBeforeFirstText: harnessReadMs
            )
        }

        sleep(Double(settings.pollIntervalMs) / 1_000)
    }

    let source: TextChangeSource = latestSnapshot.lastChangeAt == nil ? .poll : .event
    return ResponseWindowObservation(
        outcome: .timedOut,
        text: lastPolledText,
        firstMeaningfulTextAt: latestSnapshot.firstMeaningfulChangeAt ?? pollFirstTextAt,
        lastTextChangeAt: latestSnapshot.lastChangeAt ?? pollLastChangeAt,
        stabilityConfirmedAt: nil,
        source: source,
        changeCount: source == .event ? latestSnapshot.changeCount : polledChangeCount,
        harnessReadMsBeforeFirstText: harnessReadMs
    )
}
