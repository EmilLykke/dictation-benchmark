export const DATASET_IDS = [
  "test-clean",
  "test-other",
  "es_419",
  "da_dk",
  "hu_hu",
] as const;

export type DatasetId = (typeof DATASET_IDS)[number];

export interface ManifestEntry {
  /**
   * The per-corpus display id. **Not identity** — see `clipId`.
   *
   * LibriSpeech's is the utterance id and happens to be unique. FLEURS' is
   * `<locale>_<TSV column 0>` and is **not**: column 0 is the *sentence* id, FLEURS
   * records several speakers per sentence, and Danish has 930 clips behind 350
   * distinct values (measured, `tests/fleurs-identity.manual.ts`). It is kept because
   * the v1 `manifestFingerprint` is taken over it and every `selection` record in
   * `results/` is an offset into that fingerprint's ordering — changing the input
   * would invalidate the whole committed archive at once. It is a label, and nothing
   * may key on it.
   */
  id: string;
  /**
   * Canonical clip identity: the audio file's corpus-relative POSIX path
   * (`fleurs/da_dk/audio/test/12149430079508542992.wav`).
   *
   * The one string that says *which audio file* a measurement is about, agreed with
   * Codictate (SPEC §1, `src/contract/clip-identity.ts`). Every dedup, resume skip,
   * pool key and v2 fingerprint input is this and never `id`.
   */
  clipId: string;
  audioPath: string;
  transcript: string;
  rawTranscript?: string;
  /**
   * FLEURS TSV column 0, the *sentence* id. Metadata only.
   *
   * Several clips share one `sentenceId` — that is the whole reason `clipId` exists —
   * so it is never identity, never a dedup key and never a fingerprint input. Kept
   * because it is the right key for "did the product get this *sentence* right across
   * speakers", which is a question worth asking later. Absent for LibriSpeech.
   */
  sentenceId?: string;
  language: string;
  audioDurationSec: number;
}

export interface Hotkey {
  keyCode: number;
  modifiers: Array<"command" | "control" | "fn" | "option" | "shift">;
}

export interface ProductMetadata {
  id: string;
  label: string;
  version: string | null;
}

export interface PreflightResult {
  accessibilityTrusted: boolean;
  productRunning: boolean;
  outputDeviceFound: boolean;
  outputDevices: string[];
}

export interface TranscriptionRequest {
  audioPath: string;
  deviceName: string;
  hotkey: Hotkey;
  leadMs: number;
  tailMs: number;
  timeoutMs: number;
  stableMs: number;
  /**
   * How often the bridge re-reads the receiver window while waiting for text.
   *
   * A bias term **only when the bridge fell back to polling**, i.e. when the reply's
   * `textChangeSource` is `"poll"`. Since 2026-09-04 the bridge detects text changes
   * from `NSTextStorage.didProcessEditingNotification` on the receiver `NSTextView`,
   * which stamps the change itself, so on the event path the stamps carry no interval
   * bias at all and the reply says so with `textChangeBiasMs: 0`. Polling remains the
   * documented fallback and only governs how fast *stability* is declared. Read
   * `textChangeBiasMs` off the reply rather than assuming this value applied.
   */
  pollIntervalMs: number;
}

export interface TranscriptionResult {
  status: "ok" | "timeout" | "failed";
  transcript: string;
  audioPlaybackMs: number;
  stopToFirstTextMs: number | null;
  stopToStableTextMs: number | null;
  /**
   * The harness's own measured share of `stopToFirstTextMs`: time the bridge spent
   * hopping to the main thread to read the receiver window, summed over the polls
   * up to the one that first saw text.
   *
   * Emitted so a run can state its overhead as a measurement. Runs before
   * 2026-09-04 have no value here and were not clean: they restored the default
   * output device inside the window, which cost roughly 300ms per clip.
   */
  stopToFirstTextHarnessMs: number | null;
  /**
   * Measured cost of putting the user's default output device back after the clip,
   * or `null` when no switch was needed. Now performed after the response window
   * closes, so it is reported beside the latency rather than inside it.
   */
  outputDeviceRestoreMs: number | null;
  /**
   * **The response metric.** Stop Z-keydown edge to the last actual change in the
   * pasted text, in milliseconds.
   *
   * Raw: the 750 ms stability confirmation happens entirely *after* the instant this
   * records, so there is no delay in it and nothing to subtract. This is the number
   * that becomes a Sample's `responseMs`; `stopToStableTextMs` below is **not** a
   * response time and must never be substituted for it.
   *
   * `null` when there was nothing to measure — the `failed` path, or a timeout with
   * no text at all.
   */
  stopToLastTextChangeMs: number | null;
  /**
   * The confirmation delay the bridge applied, echoing the request's `stableMs`.
   *
   * Recorded so a record states its own timing terms rather than leaving a reader to
   * assume the current default. Outside the response window by construction.
   */
  stabilityDelayMs: number;
  /**
   * Which signal produced the text-change stamps: the `NSTextStorage` editing
   * notification, or the polling fallback.
   *
   * `null` on the `failed` path, where no window was observed. A record that does not
   * say which of the two it used cannot be corrected later, which is why this is
   * emitted rather than inferred from whether `pollIntervalMs` was set.
   */
  textChangeSource: "event" | "poll" | null;
  /** Text changes observed inside the window. `null` when no window was observed. */
  textChangeCount: number | null;
  /**
   * The stated measurement bias on the change stamps, in milliseconds.
   *
   * `0` on the event path, because the notification stamps the change itself. One
   * whole poll interval on the fallback path, because there the stamp is the poll. A
   * bias reported beside the number, never folded into it.
   */
  textChangeBiasMs: number | null;
  /**
   * Start Z-keydown edge to stop Z-keydown edge.
   *
   * Emitted as proof that the lead silence, the playback and the tail all precede the
   * stop stamp: this is always at least `leadMs + audioPlaybackMs + tailMs`, so a
   * reader can check that the response window does not overlap the audio.
   */
  startToStopMs: number | null;
  /**
   * Which clock both edges were stamped from. `"monotonic"` since 2026-09-04.
   *
   * Provenance, so a pooled figure can tell a post-fix clip from a pre-fix one without
   * consulting a run date. `src/contract/timing.ts::speedCompatible` requires it.
   */
  timingClock: "monotonic";
  /**
   * Which key transition both edges were stamped at. `"keydown"` since 2026-09-04.
   *
   * Provenance, and the reason the existing Flow results must be rerun: a sample
   * without it was stamped after `post(hotkey)` returned, which excluded the 50 ms Z
   * hold and the 20 ms Option-release settle plus scheduler slop — **81 to 90 ms per
   * clip, measured**, every millisecond of it in Flow's favour.
   * `src/contract/timing.ts::speedCompatible` requires it.
   */
  hotkeyEdge: "keydown";
  diagnostic?: string;
}

export interface ProductAdapter {
  metadata(): Promise<ProductMetadata>;
  preflight(deviceName: string): Promise<PreflightResult>;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
  close(): Promise<void>;
}
