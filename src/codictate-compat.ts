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
  stopToFirstTextMs: number | null;
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
    stableMs: number;
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
  /**
   * Mean milliseconds from the stop hotkey to text arriving in the receiver window.
   *
   * This, not `meanRTF`, is the product's response time. The harness plays every clip
   * through a virtual microphone at 1.0x real time, so `totalWallSec` can never fall
   * below `totalAudioSec` and `meanRTF` is floored at 1.0 by the harness itself - about
   * two thirds of it is playback we chose to do, not the product responding.
   *
   * Averaged over the scored clips that recorded one, which is not every scored clip:
   * a clip that timed out with nothing pasted records `null`, and a null averaged as 0
   * would read as instant. Optional for the same reason `cer` is - a dataset that got
   * nothing back at all has nothing to average, and is absent here rather than 0.
   */
  meanStopToFirstTextMs?: number;
  /**
   * Mean milliseconds from the stop hotkey to the moment the pasted text stopped
   * changing. Same denominator rule as `meanStopToFirstTextMs`, and it can differ:
   * text that arrived but never settled records a first-text time and no stable time.
   *
   * NOT the product's own settling time. The harness declares text stable only once it
   * has been unchanged for `config.stableMs`, and stamps the timestamp when that wait
   * finishes, so every value here carries that window on top of the real one. Subtract
   * `config.stableMs` before publishing it. It is emitted raw, with the window emitted
   * beside it, so the correction happens where a reader can see it rather than inside
   * this transform.
   */
  meanStopToStableTextMs?: number;
  /**
   * Milliseconds of waiting this product cost per second of audio dictated:
   * `totalStopToFirstTextMs / respondedAudioSec`.
   *
   * Deliberately NOT called `meanRTF`, and `meanRTF` must never be set to it. Codictate's
   * `meanRTF` is `totalWallSec / totalAudioSec` around its own inference call and nothing
   * else, so its unit is seconds of work per second of audio; this is the same unit in
   * milliseconds, over the only stretch of this product's work the harness can see.
   * `meanRTF` on this leaf stays what the harness actually clocked, which is dominated by
   * the 1.0x playback the harness chose to do, and is not comparable to anything.
   *
   * A ratio rather than the flat `meanStopToFirstTextMs` because the wait scales with
   * clip length: per-sample `stopToFirstTextMs` regressed on `audioDurationSec` gives
   * r = 0.59 to 0.90 with slopes of 38 to 77 ms per audio second, so most of it is work
   * proportional to the audio and not a fixed round trip.
   *
   * Read it as "how long do I wait per second of audio I dictated", which is the same
   * question Codictate's figure answers, and not as this product's total compute: Flow
   * streams audio while the user is still speaking, so part of its transcription overlaps
   * with speech and never appears in this measurement.
   *
   * Absent under the same rule as `meanStopToFirstTextMs`, and for the same reason: a
   * dataset that got nothing back has no numerator, and 0 would read as instant.
   */
  responseMsPerAudioSec?: number;
  /**
   * The numerator of `responseMsPerAudioSec`: summed `stopToFirstTextMs` over the scored
   * clips that recorded one. Emitted because it is not recoverable from
   * `meanStopToFirstTextMs` without the clip count that mean was taken over, and that
   * count is not `utteranceCount` - hu_hu timed out 13 times with nothing pasted.
   */
  totalStopToFirstTextMs?: number;
  /**
   * The denominator of `responseMsPerAudioSec`: summed `audioDurationSec` over those same
   * clips, and deliberately not `totalAudioSec`.
   *
   * A timed-out clip has no latency to put in the numerator, so its audio must leave the
   * denominator too. Counting it on the bottom only would be identical to counting its
   * latency as 0, which makes the slowest datasets read fastest: hu_hu is 176 ms/s over
   * the clips that answered and 168 over all of them.
   *
   * Published so a consumer can pool datasets audio-weighted as
   * `sum(totalStopToFirstTextMs) / sum(respondedAudioSec)`, matching how Codictate pools
   * `totalWallSec / totalAudioSec`. Averaging the per-dataset ratios unweighted is wrong.
   */
  respondedAudioSec?: number;
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
     * stable. Published because `meanStopToStableTextMs` includes it: without the
     * window beside the measurement, a consumer would have to know the number by
     * heart to read the measurement correctly.
     */
    stableMs: number;
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
      stableMs: run.config.stableMs,
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
    ...meanLatency("meanStopToFirstTextMs", scored, (sample) => sample.stopToFirstTextMs),
    ...meanLatency("meanStopToStableTextMs", scored, (sample) => sample.stopToStableTextMs),
    ...responseRate(scored),
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

/**
 * One latency mean, under the given name, over the clips that recorded one.
 *
 * A clip the product returned nothing for records `null`, and the denominator is the
 * clips that measured something rather than every scored clip: counting a null as 0
 * would pull the mean towards "instant" in exactly the runs where the product was
 * slowest. Yields `{}` when nothing measured, so the key is absent rather than 0.
 */
function meanLatency<K extends string>(
  key: K,
  scored: CompatibleSample[],
  select: (sample: CompatibleSample) => number | null,
): Partial<Record<K, number>> {
  const measured = scored
    .map(select)
    .filter((value): value is number => value !== null);
  if (measured.length === 0) return {};
  return { [key]: sum(measured, (value) => value) / measured.length } as Record<K, number>;
}

/**
 * The response-time ratio and the two sums it came from, over the scored clips that got
 * text back.
 *
 * One filter drives both sides on purpose. A clip with no `stopToFirstTextMs` contributes
 * neither its (absent) latency nor its audio, because leaving its audio in the denominator
 * is arithmetically the same as claiming the product answered it instantly.
 *
 * Yields `{}` when no clip answered, so all three keys are absent together rather than
 * publishing a 0 ms/s that would read as instant, and rather than a 0/0 NaN.
 */
function responseRate(
  scored: CompatibleSample[],
): Partial<
  Pick<
    CodictateModelDatasetResult,
    "responseMsPerAudioSec" | "totalStopToFirstTextMs" | "respondedAudioSec"
  >
> {
  const responded = scored.filter((sample) => sample.stopToFirstTextMs !== null);
  const totalStopToFirstTextMs = sum(responded, (sample) => sample.stopToFirstTextMs!);
  const respondedAudioSec = sum(responded, (sample) => sample.audioDurationSec);
  if (responded.length === 0 || respondedAudioSec === 0) return {};
  return {
    responseMsPerAudioSec: totalStopToFirstTextMs / respondedAudioSec,
    totalStopToFirstTextMs,
    respondedAudioSec,
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
