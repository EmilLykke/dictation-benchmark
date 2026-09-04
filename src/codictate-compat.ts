import type { DatasetId, ProductMetadata } from "./types";
import type { CerResult, WerResult } from "./scoring";

export const CODICTATE_MODEL_ID = "wispr-flow";
export const EXTERNAL_PRODUCT_HARNESS = "external-product";

export interface CompatibleSample {
  warmup: boolean;
  /**
   * How the clip ended. A `timeout` or `failed` clip is scored as an empty hypothesis,
   * so it is indistinguishable from a badly transcribed one once only rates survive -
   * which is why the counts below are published rather than left to be derived.
   */
  status: "ok" | "timeout" | "failed";
  audioDurationSec: number;
  wallClockMs?: number;
  audioPlaybackMs: number;
  /**
   * Kept only because `sampleWallMs` falls back to it for runs written before
   * `wallClockMs` existed. Deliberately not aggregated: see the note on this
   * file's removed latency fields.
   */
  stopToStableTextMs: number | null;
  wer: WerResult;
  cer?: CerResult;
}

interface CompatibleDataset {
  samples: CompatibleSample[];
  /**
   * The consumable range this run measured, when it recorded one. Read only to
   * decide whether a dataset finished: with `--samples` as a delta and exhaustion
   * truncating a range, `samples.length` no longer has to reach `config.samples`.
   */
  selection?: {
    startIndex: number;
    plannedEndIndex: number;
  };
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
    /**
     * Consumable clips this run set out to measure per dataset. Absent when the depth
     * was given as `--to`, in which case the per-dataset ranges carry it instead.
     */
    samples?: number;
    /** Target depth, when the run was launched with `--to`. */
    to?: number;
    leadMs: number;
    tailMs: number;
    stableMs: number;
    pollIntervalMs?: number;
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
  /*
   * No latency or response-speed aggregate is published here, on purpose.
   *
   * This leaf used to carry `meanStopToFirstTextMs`, `meanStopToStableTextMs`,
   * `responseMsPerAudioSec`, `totalStopToFirstTextMs` and `respondedAudioSec`. Every
   * one of them was a sum or a mean of the per-clip `stopToFirstTextMs` that the
   * bridge recorded with its own output-device restore inside the measured window:
   * a synchronous Core Audio call, roughly 300ms, charged to the product on every
   * clip. It showed up as a floor of about 317ms that was flat against clip length,
   * and it was the whole of the fixed term in the fast datasets. Pooled, it moved
   * the published figure from 123 ms per audio second to 91 to 96, which reverses
   * the ordering against `large-v3-q5_0` at 99.
   *
   * `main.swift` no longer restores the device inside the window and now records
   * both `stopToFirstTextHarnessMs` and `outputDeviceRestoreMs` per clip, so a
   * future run can publish a speed figure and say what its own overhead was. This
   * transform stays silent about speed until such a run exists, because a consumer
   * cannot tell a clean aggregate from a contaminated one by looking at it. The raw
   * per-clip numbers stay in `results.json`, where they are what they say they are.
   */
  peakRSS_MB: null;
  utteranceCount: number;
  /**
   * Scored clips the product returned nothing usable for, counted the same way this
   * run's `results.json` aggregate counts them: a scored sample whose `status` is not
   * `ok`.
   *
   * Not derivable downstream. A timed-out clip is scored as an empty hypothesis and so
   * still counted in `utteranceCount`, which makes `sampleSize - warmupCount -
   * utteranceCount` read 0 for a run that timed out 14 times. Emitting the count is the
   * only way a consumer can disclose it.
   */
  failures: number;
  /**
   * The same failures split by the `status` that produced them, so a consumer can say
   * "timed out" rather than the vaguer "failed". Always emitted, including as zeros:
   * an absent breakdown would not distinguish "nothing failed" from "not recorded".
   */
  failuresByStatus: {
    timeout: number;
    failed: number;
  };
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
    /**
     * How long the harness required the pasted text to hold still before calling it
     * stable. A condition of the run: it is the harness's own wait, it sits on top of
     * whatever the product's real settling time is, and it is part of `totalWallSec`.
     */
    stableMs: number;
    /**
     * How often the bridge re-read the receiver window while waiting for text, and so
     * the granularity of the per-clip latencies in `results.json`. Absent on runs
     * recorded before the interval was configurable, which used a hardcoded 50ms.
     */
    pollIntervalMs?: number;
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
      sampleSize: sampleSize(run),
      warmupCount: 3,
      normalization: "whisper-basic",
      stableMs: run.config.stableMs,
      ...(run.config.pollIntervalMs !== undefined
        ? { pollIntervalMs: run.config.pollIntervalMs }
        : {}),
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
  const isComplete = current !== undefined && isDatasetComplete(current, run.config);
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

/**
 * Whether a dataset ran to the end of the range this run planned for it.
 *
 * Prefers the recorded range over `config.samples`, because `config.samples` is now
 * a delta measured from a cursor and because exhaustion can legitimately shorten a
 * range: a dataset with 40 clips left under `--samples 400` is complete at 40, and
 * comparing against 400 would silently drop it out of `stt.json`.
 */
function isDatasetComplete(
  result: CompatibleDataset,
  config: CompatibleRun["config"],
): boolean {
  if (result.selection) {
    return scoredSamples(result.samples).length
      >= result.selection.plannedEndIndex - result.selection.startIndex;
  }
  if (config.samples === undefined) return true;
  return result.samples.length >= config.samples;
}

/**
 * Scored clips per dataset in this run. Not a corpus depth: a run is one session,
 * and `utteranceCount` on each leaf is the exact per-dataset count.
 */
function sampleSize(run: CompatibleRun): number {
  if (run.config.samples !== undefined) return run.config.samples;
  const counts = run.config.datasets
    .map((dataset) => run.results[dataset])
    .filter((result): result is CompatibleDataset => result !== undefined)
    .map((result) => scoredSamples(result.samples).length);
  return counts.length === 0 ? 0 : Math.max(...counts);
}

function completedResults(run: CompatibleRun): {
  librispeech: DatasetResults;
  fleurs: DatasetResults;
} {
  const librispeech: DatasetResults = {};
  const fleurs: DatasetResults = {};
  for (const dataset of run.config.datasets) {
    const result = run.results[dataset];
    if (!result || !isDatasetComplete(result, run.config)) continue;
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
  const scored = scoredSamples(samples);
  const failed = scored.filter((sample) => sample.status !== "ok");
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
    failures: failed.length,
    failuresByStatus: {
      timeout: failed.filter((sample) => sample.status === "timeout").length,
      failed: failed.filter((sample) => sample.status === "failed").length,
    },
    totalAudioSec: partial.totalAudioSec,
    totalWallSec: partial.totalWallSec,
  };
}

function partialProgress(
  samples: CompatibleSample[],
  config: CompatibleRun["config"],
): PartialProgress {
  const scored = scoredSamples(samples);
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

/** Samples the published numbers are computed over: everything but the warmups. */
function scoredSamples(samples: CompatibleSample[]): CompatibleSample[] {
  return samples.filter((sample) => !sample.warmup);
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
