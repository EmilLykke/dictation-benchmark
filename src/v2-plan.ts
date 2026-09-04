/**
 * The seam between this harness's index-space planning and the contract's clip-space
 * Run Plan.
 *
 * `src/selection.ts` thinks in integer offsets into a deterministically ordered
 * manifest, because that is what the accumulating cursor needs and what every record
 * in `results/` is written in. `src/contract/selection.ts` thinks in `clipId` sets,
 * because that is what makes resume, overlap and pooling set operations rather than
 * arithmetic. Both are right for their job and the conversion has to happen exactly
 * once, in one place, or the two spaces drift and a record's offsets stop naming the
 * clips beside them.
 *
 * This module is that place. Nothing here reads a clock or a filesystem: the caller
 * supplies `createdAt` and the manifest.
 */

import {
  buildRunPlan,
  HARNESS_WISPR_FLOW,
  resumeSelection,
  type ResumeSelection,
  type MeasuringHarness,
  type RunPlan,
  type SampleMeasurementV2,
} from "./contract";
import type { DatasetPlan } from "./selection";
import { consumableEntries, warmupEntries } from "./selection";
import type { DatasetId, ManifestEntry } from "./types";

/**
 * The measuring harness this repository writes into every v2 record.
 *
 * Read from the contract rather than spelled out, because it is a pooling key
 * (`compatibilityKey`) and a typo here would create a second series that pools with
 * nothing and looks like an unmeasured product.
 */
export const HARNESS_ID = HARNESS_WISPR_FLOW;

/**
 * The dataset id both repositories use: the corpus, then the split or locale.
 *
 * `test-clean` alone is this repository's CLI spelling and is ambiguous across
 * corpora; `librispeech/test-clean` is the one a pooled reader can key on, and it is
 * also the prefix of every `clipId` in the dataset — which is what makes a record whose
 * `datasetId` disagrees with its clips detectable (`compatibilityKey`).
 */
export function datasetIdOf(dataset: DatasetId | string): string {
  return dataset.startsWith("test-") ? `librispeech/${dataset}` : `fleurs/${dataset}`;
}

export interface RunPlanInput {
  runId: string;
  batchId?: string;
  model: string;
  dataset: DatasetId | string;
  entries: readonly ManifestEntry[];
  /** First consumable index, inclusive. Consumable-relative (SPEC addendum §E). */
  fromIndex: number;
  /** One past the last consumable index. */
  toIndex: number;
  /** ISO 8601, injected so a plan is reproducible in a test. */
  createdAt: string;
  harness?: MeasuringHarness;
}

/**
 * The immutable Run Plan for one (harness, model, dataset) slice, in clip space.
 *
 * The warmups come from `warmupEntries` and the scored clips from
 * `consumableEntries`, so index 0 of the plan is the first clip *after* the Warmup
 * Reservation — the same index space `SampleRange` and every `selection` record in
 * `results/` use (SPEC addendum §E). The two lists are disjoint by construction, which
 * `buildRunPlan` asserts: a clip that was both warmed and scored would be measured on
 * a model that had just seen it.
 */
export function runPlanFor(input: RunPlanInput): RunPlan {
  return buildRunPlan({
    runId: input.runId,
    ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
    datasetId: datasetIdOf(input.dataset),
    harness: input.harness ?? HARNESS_ID,
    model: input.model,
    consumableClipIds: consumableEntries(input.entries).map((entry) => entry.clipId),
    fromIndex: input.fromIndex,
    toIndex: input.toIndex,
    warmupClipIds: warmupEntries(input.entries).map((entry) => entry.clipId),
    createdAt: input.createdAt,
  });
}

/** The Run Plan a `DatasetPlan` describes. Same range, expressed in clipIds. */
export function runPlanForDatasetPlan(
  plan: DatasetPlan,
  entries: readonly ManifestEntry[],
  input: Omit<RunPlanInput, "dataset" | "entries" | "fromIndex" | "toIndex">,
): RunPlan {
  return runPlanFor({
    ...input,
    dataset: plan.dataset,
    entries,
    fromIndex: plan.startIndex,
    toIndex: plan.endIndex,
  });
}

/**
 * What this session must play, given the plan and the clips already captured.
 *
 * Delegates to `src/contract/selection.ts::resumeSelection` rather than re-deriving
 * the rule, because the rule is the one defect 6 was: **warmups always replay and
 * completed scored clips never do**, and the two were conflated by a single
 * completed-id filter that removed both. A resumed process starts against a cold
 * product, so the warmups are the entire point of the resumed session's first three
 * clips; a completed scored clip is a measurement already on disk, and re-running it
 * either double-counts it or overwrites a real observation with a luckier one.
 *
 * A recorded `failed` or `timeout` clip counts as completed and is **not** replayed
 * (SPEC addendum §G). It is a counted measurement: it sits in `attemptedCount` and
 * `failureCount` and contributes nothing to speed, and replaying it until it passes
 * would launder it. Re-measuring on purpose is a new run with an explicit start index,
 * never a resume.
 */
export function sessionSelection(
  plan: RunPlan,
  capturedClipIds: Iterable<string>,
): ResumeSelection {
  const captured = new Set(capturedClipIds);
  // `resumeSelection` reads Samples rather than a set, because on disk that is what
  // exists and the warmup flag has to come from somewhere. Synthesised here from the
  // set the runner already maintains; only `clipId` and `isWarmup` are read.
  const samples: SampleMeasurementV2[] = [...captured].map((clipId) => ({
    clipId,
    audioDurationSec: 0,
    responseMs: null,
    status: "ok",
    wordErrors: 0,
    referenceWords: 0,
    charErrors: 0,
    referenceChars: 0,
    isWarmup: false,
  }));
  return resumeSelection(plan, samples);
}
