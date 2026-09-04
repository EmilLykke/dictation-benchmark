export const DATASET_IDS = [
  "test-clean",
  "test-other",
  "es_419",
  "da_dk",
  "hu_hu",
] as const;

export type DatasetId = (typeof DATASET_IDS)[number];

export interface ManifestEntry {
  id: string;
  audioPath: string;
  transcript: string;
  rawTranscript?: string;
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
   * This is the granularity of `stopToFirstTextMs`, so it is a bias term: on
   * average a clip's first text is discovered half an interval after it landed.
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
  diagnostic?: string;
}

export interface ProductAdapter {
  metadata(): Promise<ProductMetadata>;
  preflight(deviceName: string): Promise<PreflightResult>;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
  close(): Promise<void>;
}
