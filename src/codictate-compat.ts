import {
  assertV2OnV1Leaf,
  clipIdFromRelativeAudioPath,
  INSTRUMENTATION_ASYMMETRY_LABEL,
  pooledInferenceRtf,
  pooledSpeed,
  type LeafSpeedV2,
  type SampleMeasurementV2,
} from "./contract";
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
   * Stop edge to *confirmed-stable* text. **Includes the 750 ms stability delay** plus
   * up to one poll of noticing it, so it is not a response time and is never
   * substituted for one.
   *
   * Read for two things and nothing else: `sampleWallMs` falls back to it for runs
   * written before `wallClockMs` existed, and `responseMsOf` falls back to it so a
   * pre-2026-09-04 clip still has *a* readable number. That fallback cannot leak into
   * a published figure, because such a clip carries no timing provenance and
   * `speedCompatible` therefore keeps it out of the pooled ratio.
   */
  stopToStableTextMs: number | null;
  /**
   * **The response metric.** Stop Z-keydown edge to the last actual pasted-text
   * change. See `TranscriptionResult.stopToLastTextChangeMs`.
   *
   * Optional because runs recorded before 2026-09-04 have none.
   */
  stopToLastTextChangeMs?: number | null;
  /** Provenance: `"monotonic"` for a post-fix clip, absent for a pre-fix one. */
  timingClock?: string | null;
  /** Provenance: `"keydown"` for a post-fix clip, absent for a pre-fix one. */
  hotkeyEdge?: string | null;
  /** Canonical clip identity, when the record carries it. */
  clipId?: string;
  /**
   * The record's portable audio path, which *is* the canonical clipId string for every
   * committed run. Read only as the `clipId` fallback for older records.
   */
  audioPath?: string;
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
  /**
   * **Required on a v2 leaf**, and a parity fix rather than a preference.
   *
   * Codictate wrote it and this harness did not, so `charts.py::_leaf_word_errors` used
   * an exact integer for one product and a derived float (`wer * referenceWords`) for
   * the other - two numerators of different kinds pooled into one published rate, with
   * float error accumulating on only one side of the comparison.
   */
  wordErrors: number;
  cer?: number;
  /** Reference characters the CER was divided by. Absent wherever `cer` is absent. */
  referenceChars?: number;
  /** Character-level edit distance. Present exactly where `cer` is. */
  charErrors?: number;
  /**
   * **Legacy, and unfiltered.** Session wall clock over audio, over **all** scored
   * samples - `speedCompatible` is not applied to it.
   *
   * `meanRTF`, `totalWallSec` and `totalAudioSec` keep their v1 meaning exactly,
   * because the archived leaves were computed this way and redefining them would make
   * every new run incomparable to the archive it is published beside - silently, since
   * the field name would not change. It is floored at 1.0 by playback this harness chose
   * to do, and `sampleWallMs` includes `leadMs`, `tailMs` and the 750 ms stability wait,
   * so it is not a response time and never stands in for one.
   *
   * All provenance-filtered v2 speed lives under `speedV2` and nowhere else. The two
   * deliberately differ on a run with excluded clips, and
   * `src/contract/v1-leaf.ts::publishableWallRtf` is the function that refuses to fall
   * back from one to the other.
   */
  meanRTF: number;
  /**
   * The v2 response-speed summary for this dataset. **Pooled, and provenance-gated.**
   *
   * The field is **`speedV2`**, from `src/contract/v1-leaf.ts::LEAF_SPEED_V2_FIELD`, and
   * the name is load-bearing rather than cosmetic. It was written here as `speed` while
   * Codictate wrote `speedV2` and `charts.py` read `speedV2`, so every external row
   * found nothing and fell through to a `meanRTF` fallback - a differently defined,
   * unfiltered, playback-floored number rendered in a v2 chart at up to 28x the
   * contract value. A bare `speed` also invites a reader to treat it as a v1 field and
   * leaves a v3 nowhere to go.
   *
   * The flat `meanStopToFirstTextMs`, `meanStopToStableTextMs`,
   * `responseMsPerAudioSec`, `totalStopToFirstTextMs` and `respondedAudioSec` fields
   * this leaf once carried are gone and are not coming back, and nothing here is a
   * rename of one of them. Each of those was a sum or a mean over per-clip
   * `stopToFirstTextMs` values the bridge recorded with its own Core Audio
   * output-device restore inside the measured window: a synchronous call, roughly
   * 300 ms, charged to the product on every clip. It showed up as a floor of about
   * 317 ms flat against clip length, and pooled it moved the published figure from
   * 123 ms per audio second to 91-96 - which reverses the ordering against
   * `large-v3-q5_0` at 99. Publishing that was the defect; withholding every figure
   * for ever was the stopgap.
   *
   * What replaces the stopgap is a **filter with a stated count** rather than
   * silence. The restore is now outside the window and both hotkey edges are stamped
   * at the Z keydown transition, so a clip measured after 2026-09-04 records
   * `timingClock: "monotonic"` and `hotkeyEdge: "keydown"` and may be pooled.
   * `src/contract/timing.ts::speedCompatible` excludes every clip that cannot prove
   * both, and `speed.speedExcludedCount` says how many it excluded - so a leaf built
   * entirely from pre-fix clips reads `responseMsPerAudioSec: null` beside the count
   * that explains the null, instead of a field a consumer cannot tell from a clean
   * one. That is the case for every dataset in
   * `results/20260902_181511_wispr-flow-all-400`, and
   * `tests/compat-speed.test.ts` pins it.
   *
   * The raw per-clip numbers stay in `results.json`, where they are labelled as what
   * they are.
   */
  speedV2: LeafSpeedV2;
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
  /**
   * The one sentence every surface showing both products must print, verbatim.
   *
   * Read from `src/contract/timing.ts::INSTRUMENTATION_ASYMMETRY_LABEL` rather than
   * written out here, because the report, the chart subtitles and the staging reader
   * all have to say the same thing and three paraphrases is how a reader ends up
   * believing the two numbers are the same measurement. SPEC §5, addendum §J.
   */
  instrumentationNote: string;
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
    instrumentationNote: INSTRUMENTATION_ASYMMETRY_LABEL,
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
  const leaves = samples.map(speedLeaf);
  const leaf: CodictateModelDatasetResult = {
    wer: partial.totalRefWords === 0 ? 0 : partial.totalWer / partial.totalRefWords,
    referenceWords: partial.totalRefWords,
    wordErrors: partial.totalWer,
    ...(partial.totalCer !== undefined && partial.totalRefChars
      ? {
          cer: partial.totalCer / partial.totalRefChars,
          referenceChars: partial.totalRefChars,
          charErrors: partial.totalCer,
        }
      : {}),
    // Unfiltered, over every scored sample, exactly as v1 computed it. See the note on
    // the field.
    meanRTF: partial.totalAudioSec === 0 ? 0 : partial.totalWallSec / partial.totalAudioSec,
    speedV2: speedV2For(leaves),
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
  // Checked against the shared shape rather than trusted. Every complaint this catches
  // is a consumer that would otherwise get a different number from the two harnesses -
  // a summary under the wrong key, a rate that disagrees with its own counts, a CER
  // present without its denominator.
  assertV2OnV1Leaf(leaf, { pooledRunCount: 1 });
  return leaf;
}

/**
 * The pooled v2 speed summary plus the Codictate-only inference diagnostic.
 *
 * The diagnostic is emitted with its counts even though this harness can never populate
 * `overhead.inferenceMs` - a UI-observed paste has no inference boundary to measure - so
 * `inferenceRtf` is always `null` and `inferenceSkippedCount` equals the scored count.
 * Emitted rather than omitted because the shared leaf shape requires the fields, and a
 * `null` rate beside a skip count is readable as "not measurable here" where an absent
 * field would be indistinguishable from "not recorded".
 */
function speedV2For(leaves: readonly SampleMeasurementV2[]): LeafSpeedV2 {
  const inference = pooledInferenceRtf(leaves);
  return {
    ...pooledSpeed(leaves),
    inferenceRtf: inference.rtf,
    inferenceMs: inference.inferenceMs,
    inferenceAudioSec: inference.audioDurationSec,
    inferenceSampleCount: inference.leafCount,
    inferenceSkippedCount: inference.skippedCount,
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
  // Reconstructing a wall time for a record written before `wallClockMs` existed. The
  // response metric is preferred; `stopToStableTextMs` is the legacy fallback and it
  // carries the 750 ms stability delay, which for *this* purpose is right - the harness
  // really did wait it, and it really was part of the session's wall clock. It is only
  // wrong as a response time, which is why `responseMsOf` below prefers the same field
  // in the same order and the pooled ratio then refuses the fallback outright.
  return sample.audioPlaybackMs
    + config.leadMs
    + config.tailMs
    + (sample.stopToLastTextChangeMs ?? sample.stopToStableTextMs ?? 0);
}

/**
 * The response time of one clip, preferring the metric over the legacy number.
 *
 * `stopToLastTextChangeMs` is the stop Z-keydown edge to the last actual pasted-text
 * change. `stopToStableTextMs` is that plus the 750 ms confirmation plus up to one
 * poll, so it is not a response time; it is here so a pre-2026-09-04 clip still reads
 * as *something* rather than as a null that looks like a failure. Such a clip has no
 * `timingClock`/`hotkeyEdge`, so `speedCompatible` keeps it out of the pooled ratio and
 * the fallback cannot reach a published number.
 */
function responseMsOf(sample: CompatibleSample): number | null {
  return sample.stopToLastTextChangeMs ?? sample.stopToStableTextMs ?? null;
}

/**
 * One clip as the contract's pooling code wants it.
 *
 * `timingRegime` is `ui-observed-paste` unconditionally, because that is what this
 * harness is: it presses a global shortcut and watches an `NSTextView`. The two
 * provenance stamps are passed through **as recorded and never defaulted** - a
 * `hotkeyEdge: "keydown"` invented here to satisfy a type would tell
 * `speedCompatible` that a pre-fix clip was measured properly, which is the one lie
 * this whole filter exists to prevent.
 */
/**
 * The canonical clipId of a compatible sample, or a throw.
 *
 * Never a placeholder. `?? "unknown"` collapsed every sample in a record with no
 * `audioPath` to one id, so `pooledSampleCount` reported **1** for a 400-clip dataset and
 * the leaf published a sample count two orders of magnitude wrong. SPEC addendum §K is
 * the rule: an identity conversion throws where `portableAudioPath` falls back, because
 * the fallback is right for a portable record and catastrophic as identity.
 *
 * `audioPath` on a committed record is already the canonical string, so this re-derives
 * rather than guesses - and the derivation is the throwing one.
 */
function compatibleClipId(sample: CompatibleSample): string {
  if (sample.clipId) return sample.clipId;
  if (sample.audioPath) return clipIdFromRelativeAudioPath(sample.audioPath);
  throw new Error(
    `A scored sample carries neither clipId nor audioPath, so it has no identity and cannot ` +
      `be counted. Every record this harness has ever written carries a portable audioPath; ` +
      `a sample without one was hand-edited or produced by something else.`,
  );
}

function speedLeaf(sample: CompatibleSample): SampleMeasurementV2 {
  const errors = sample.wer.substitutions + sample.wer.insertions + sample.wer.deletions;
  const characterErrors = sample.cer
    ? sample.cer.substitutions + sample.cer.insertions + sample.cer.deletions
    : 0;
  return {
    clipId: compatibleClipId(sample),
    audioDurationSec: sample.audioDurationSec,
    responseMs: responseMsOf(sample),
    status: sample.status,
    wordErrors: errors,
    referenceWords: sample.wer.refWords,
    charErrors: characterErrors,
    referenceChars: sample.cer?.refChars ?? 0,
    isWarmup: sample.warmup,
    overhead: {
      timingRegime: "ui-observed-paste",
      ...(sample.hotkeyEdge == null ? {} : { hotkeyEdge: sample.hotkeyEdge }),
      ...(sample.timingClock == null ? {} : { timingClock: sample.timingClock }),
    },
  };
}

function datasetType(dataset: DatasetId): "librispeech" | "fleurs" {
  return dataset.startsWith("test-") ? "librispeech" : "fleurs";
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}
