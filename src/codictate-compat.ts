import type { DatasetId, ProductMetadata } from "./types";
import type { CerResult, WerResult } from "./scoring";

export const CODICTATE_MODEL_ID = "wispr-flow";
export const EXTERNAL_PRODUCT_HARNESS = "external-product";

interface CompatibleSample {
  warmup: boolean;
  audioDurationSec: number;
  wallClockMs?: number;
  audioPlaybackMs: number;
  stopToStableTextMs: number | null;
  wer: WerResult;
  cer?: CerResult;
}

interface CompatibleDataset {
  samples: CompatibleSample[];
}

export interface CompatibleRun {
  createdAt: string;
  completedAt?: string;
  product: ProductMetadata;
  hardware: {
    cpu: string;
    ram?: string;
    os?: string;
    osVersion?: string;
    platform?: string;
    release?: string;
  };
  config: {
    datasets: DatasetId[];
    samples: number;
    leadMs: number;
    tailMs: number;
    configurationNote: string;
  };
  results: Partial<Record<DatasetId, CompatibleDataset>>;
}

export interface CodictateModelDatasetResult {
  wer: number;
  /**
   * Reference words the WER was divided by. Codictate's own leaf carries the same
   * field under the same name, and both exist for the same reason: accuracy across
   * datasets has to be pooled as sum(errors) / sum(referenceWords), and a leaf that
   * publishes only a rate cannot be pooled with anything.
   *
   * Required here, unlike on Codictate's read type - this run's `results.json`
   * aggregate has always recorded the count, so there is no case where an
   * external-product leaf can be built without one.
   */
  referenceWords: number;
  cer?: number;
  /** Reference characters the CER was divided by. Absent wherever `cer` is absent. */
  referenceChars?: number;
  meanRTF: number;
  peakRSS_MB: null;
  utteranceCount: number;
  totalAudioSec: number;
  totalWallSec: number;
}

type HarnessResults = Record<
  typeof EXTERNAL_PRODUCT_HARNESS,
  Record<typeof CODICTATE_MODEL_ID, CodictateModelDatasetResult>
>;

type DatasetResults = Record<string, HarnessResults>;

export interface CodictateCompatibleResults {
  description: string;
  hardware: {
    chip: string;
    ram: string;
    os: string;
    osVersion: string;
  };
  runDate: string;
  config: {
    sampleSize: number;
    warmupCount: 3;
    normalization: "whisper-basic";
  };
  librispeech: DatasetResults;
  fleurs: DatasetResults;
}

interface PartialProgress {
  utterancesDone: number;
  totalWer: number;
  totalRefWords: number;
  totalCer?: number;
  totalRefChars?: number;
  totalAudioSec: number;
  totalWallSec: number;
}

export interface CodictateCompatibleCheckpoint {
  harnesses: [typeof EXTERNAL_PRODUCT_HARNESS];
  librispeech: DatasetResults;
  fleurs: DatasetResults;
  inProgress?: {
    harness: typeof EXTERNAL_PRODUCT_HARNESS;
    modelId: typeof CODICTATE_MODEL_ID;
    datasetKey: DatasetId;
    datasetType: "librispeech" | "fleurs";
    partial: PartialProgress;
  };
}

export function buildCodictateResults(run: CompatibleRun): CodictateCompatibleResults {
  const { librispeech, fleurs } = completedResults(run);
  return {
    description: [
      `${run.product.label} ${run.product.version ?? "unknown"} external-product benchmark`,
      run.config.configurationNote,
    ].filter(Boolean).join("; "),
    hardware: {
      chip: run.hardware.cpu,
      ram: run.hardware.ram ?? "unknown",
      os: run.hardware.os ?? (run.hardware.platform === "darwin" ? "macOS" : run.hardware.platform ?? "unknown"),
      osVersion: run.hardware.osVersion ?? run.hardware.release ?? "unknown",
    },
    runDate: run.completedAt ?? run.createdAt,
    config: {
      sampleSize: run.config.samples,
      warmupCount: 3,
      normalization: "whisper-basic",
    },
    librispeech,
    fleurs,
  };
}

export function buildCodictateCheckpoint(
  run: CompatibleRun,
  currentDataset?: DatasetId,
): CodictateCompatibleCheckpoint {
  const { librispeech, fleurs } = completedResults(run);
  const current = currentDataset ? run.results[currentDataset] : undefined;
  const isComplete = current !== undefined && current.samples.length >= run.config.samples;
  return {
    harnesses: [EXTERNAL_PRODUCT_HARNESS],
    librispeech,
    fleurs,
    ...(current && !isComplete
      ? {
          inProgress: {
            harness: EXTERNAL_PRODUCT_HARNESS,
            modelId: CODICTATE_MODEL_ID,
            datasetKey: currentDataset!,
            datasetType: datasetType(currentDataset!),
            partial: partialProgress(current.samples, run.config),
          },
        }
      : {}),
  };
}

function completedResults(run: CompatibleRun): {
  librispeech: DatasetResults;
  fleurs: DatasetResults;
} {
  const librispeech: DatasetResults = {};
  const fleurs: DatasetResults = {};
  for (const dataset of run.config.datasets) {
    const result = run.results[dataset];
    if (!result || result.samples.length < run.config.samples) continue;
    const target = datasetType(dataset) === "librispeech" ? librispeech : fleurs;
    target[dataset] = {
      [EXTERNAL_PRODUCT_HARNESS]: {
        [CODICTATE_MODEL_ID]: modelResult(result.samples, run.config),
      },
    };
  }
  return { librispeech, fleurs };
}

function modelResult(
  samples: CompatibleSample[],
  config: CompatibleRun["config"],
): CodictateModelDatasetResult {
  const partial = partialProgress(samples, config);
  return {
    wer: partial.totalRefWords === 0 ? 0 : partial.totalWer / partial.totalRefWords,
    referenceWords: partial.totalRefWords,
    ...(partial.totalCer !== undefined && partial.totalRefChars
      ? {
          cer: partial.totalCer / partial.totalRefChars,
          referenceChars: partial.totalRefChars,
        }
      : {}),
    meanRTF: partial.totalAudioSec === 0 ? 0 : partial.totalWallSec / partial.totalAudioSec,
    peakRSS_MB: null,
    utteranceCount: partial.utterancesDone,
    totalAudioSec: partial.totalAudioSec,
    totalWallSec: partial.totalWallSec,
  };
}

function partialProgress(
  samples: CompatibleSample[],
  config: CompatibleRun["config"],
): PartialProgress {
  const scored = samples.filter((sample) => !sample.warmup);
  const cerSamples = scored.filter((sample) => sample.cer !== undefined);
  return {
    utterancesDone: scored.length,
    totalWer: sum(
      scored,
      (sample) => sample.wer.substitutions + sample.wer.insertions + sample.wer.deletions,
    ),
    totalRefWords: sum(scored, (sample) => sample.wer.refWords),
    ...(cerSamples.length > 0
      ? {
          totalCer: sum(
            cerSamples,
            (sample) => sample.cer!.substitutions + sample.cer!.insertions + sample.cer!.deletions,
          ),
          totalRefChars: sum(cerSamples, (sample) => sample.cer!.refChars),
        }
      : {}),
    totalAudioSec: sum(scored, (sample) => sample.audioDurationSec),
    totalWallSec: sum(scored, (sample) => sampleWallMs(sample, config)) / 1_000,
  };
}

function sampleWallMs(
  sample: CompatibleSample,
  config: CompatibleRun["config"],
): number {
  if (sample.wallClockMs !== undefined) return sample.wallClockMs;
  return sample.audioPlaybackMs
    + config.leadMs
    + config.tailMs
    + (sample.stopToStableTextMs ?? 0);
}

function datasetType(dataset: DatasetId): "librispeech" | "fleurs" {
  return dataset.startsWith("test-") ? "librispeech" : "fleurs";
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}
