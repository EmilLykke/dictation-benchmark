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
}

export interface TranscriptionResult {
  status: "ok" | "timeout" | "failed";
  transcript: string;
  audioPlaybackMs: number;
  stopToFirstTextMs: number | null;
  stopToStableTextMs: number | null;
  diagnostic?: string;
}

export interface ProductAdapter {
  metadata(): Promise<ProductMetadata>;
  preflight(deviceName: string): Promise<PreflightResult>;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
  close(): Promise<void>;
}
