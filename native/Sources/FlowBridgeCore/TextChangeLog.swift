import Foundation

/// Every text change the receiver window reported, with the instant it happened.
///
/// Filled by the text-storage change notification, so the stamps are the changes
/// themselves rather than the polls that later noticed them. Not thread safe by
/// design: it is written from the notification on the main thread and read on the
/// main thread through the bridge's `onMain` hop, and confining it that way is
/// cheaper and easier to reason about than a lock inside a notification handler.
public final class TextChangeLog {
    private struct Change {
        let text: String
        let at: MonotonicInstant
    }

    private var changes: [Change] = []
    private var latestText = ""

    public init() {}

    /// Drops the previous clip's changes. Called when the receiver window is cleared
    /// and refocused, which happens before the *start* hotkey, so the reset is
    /// outside both measured edges.
    public func reset() {
        changes.removeAll()
        latestText = ""
    }

    /// Records a change, ignoring anything that did not alter the text. Attribute-only
    /// edits and re-notifications of identical content are not pastes and must not
    /// move the end of the response window.
    public func record(text: String, at instant: MonotonicInstant) {
        guard text != latestText else { return }
        latestText = text
        changes.append(Change(text: text, at: instant))
    }

    /// The window's view of the log.
    ///
    /// Only changes at or after `windowOpenedAt` count: the window opens at the stop
    /// hotkey's key-down edge, and the clear that emptied the view - or anything Flow
    /// pasted before the user stopped talking - happened before it.
    ///
    /// `liveText` is passed in rather than taken from the log so that a clip whose
    /// notifications never arrive still sees the text and degrades to poll stamps
    /// instead of timing out.
    public func snapshot(since windowOpenedAt: MonotonicInstant, liveText: String) -> TextChangeSnapshot {
        let inWindow = changes.filter { $0.at >= windowOpenedAt }
        let firstMeaningful = inWindow.first {
            !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        return TextChangeSnapshot(
            text: liveText,
            changeCount: inWindow.count,
            firstMeaningfulChangeAt: firstMeaningful?.at,
            lastChangeAt: inWindow.last?.at
        )
    }
}
