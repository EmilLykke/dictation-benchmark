/**
 * The publication batch orchestrator: one command that measures the whole matrix, and
 * publishes nothing.
 *
 * ```bash
 * bun run benchmark:publication -- --batch 2026-09-v2 --from 0 --to 400 --flow-hotkey option+z
 * ```
 *
 * The problem it solves is not "run several commands". It is that a published
 * comparison has to be over **the same clips** in both products, and the two harnesses
 * live in two repositories with two cursors. Left to a human, stage two is typed hours
 * after stage one, from a shell history, at night, and the range drifts by one flag.
 * So the range is decided **once**, written down as one fingerprinted Run Plan per
 * stage, and every later invocation reads that file rather than rebuilding one. A
 * second invocation of the identical command transcribes nothing.
 *
 * What it deliberately does not do, and why each one is deliberate:
 *
 * - **It never publishes or deploys.** It writes staging reports under the batch
 *   directory. Promotion to the leaderboard is a separate, human decision (SPEC §6),
 *   because the v2 numbers replace a published comparison and that is not a thing a
 *   batch script gets to do at 4am.
 * - **It never offloads models.** Codictate's `--offload-models` deletes a gigabyte
 *   after a run; a resumed stage would then re-download it and charge the download to
 *   the first clip's wall time.
 * - **It stops on the first failure.** Not "continues with the rest": the stages share
 *   a clip set on purpose, so a partial matrix is a comparison with a hole in it, and
 *   the useful thing to do with a failure is look at it.
 * - **It runs Wispr Flow first.** Flow is a shipped product that auto-updates and is
 *   measured through its UI; Codictate is a local adapter call that will still be there
 *   in the morning. If only one stage fits in a night, it should be the one whose
 *   subject can change underneath it.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  INSTRUMENTATION_ASYMMETRY_LABEL,
  type FingerprintV2,
  type RunPlan,
} from "./contract";
import { buildManifest } from "./manifest";
import { datasetsRoot } from "./portable-paths";
import {
  downloadMissingModels,
  modelInventory,
  pendingDownloadMB,
  type ModelStatus,
} from "./model-downloads";
import {
  allChecks,
  failures,
  formatChecks,
  repositoryChecks,
  type Check,
} from "./preflight";
import { consumableEntries, WARMUP_COUNT } from "./selection";
import { DATASET_IDS, type DatasetId, type ManifestEntry } from "./types";
import { DEFAULT_FLOW_HOTKEY, parseHotkey, type Hotkey } from "./publication-hotkey";
import { runPlanFor } from "./v2-plan";
import {
  isStageComplete,
  readRunPlan,
  scanRunRecordsV2,
  v2CursorFor,
  writeJsonAtomic,
  type ScannedV2Record,
} from "./v2-record";

/** Which harness runs a stage. Two, and they are not interchangeable. */
export type StageHarness = "wispr-flow" | "codictate";

/**
 * The Codictate Speech Models the production matrix measures on **all five dataset
 * buckets**, in order.
 *
 * Thirteen multilingual models. `large-v3-q5_0` leads because it is the one the
 * published comparison against Wispr Flow is about - the model whose 99 ms per audio
 * second the v1 Flow figure was wrongly beaten by - and the rest are the families that
 * comparison is placed among: the `large-v3` line and its quantisations, Parakeet, the
 * older `large-v1`/`large-v2` line, and `medium`. Every id is checked against the
 * Codictate catalogue at preflight, so a rename there fails loudly here rather than
 * reading as a download problem.
 */
export const MULTILINGUAL_MODELS = [
  "large-v3-q5_0",
  "large-v3",
  "large-v3-turbo",
  "large-v3-turbo-q5_0",
  "large-v3-turbo-q8_0",
  "parakeet-tdt-0.6b-v3",
  "large-v1",
  "large-v2",
  "large-v2-q5_0",
  "large-v2-q8_0",
  "medium",
  "medium-q5_0",
  "medium-q8_0",
] as const;

/**
 * The Danish-pinned models: measured on `da_dk` **only**.
 *
 * hviske transcribes as Danish whatever it is handed, so an English split would measure
 * Danish decoding of English speech rather than the model. Codictate's own README says
 * the same thing about `--splits none --languages da_dk`, and that is exactly the
 * invocation this orchestrator builds for them.
 *
 * They are **not** a second ASR Harness: `HVISKE_ASR_HARNESS` is `crispasr`, the same
 * single runnable harness, using its `cohere` backend. So `compatibilityKey`'s missing
 * ASR-Harness dimension (SPEC addendum §W) stays sound across this matrix and nothing
 * here needs to grow one.
 */
export const DANISH_ONLY_MODELS = [
  "hviske-v5-tiny-f16",
  "hviske-v5-tiny-q8_0",
  "hviske-v5-tiny-q6_k",
  "hviske-v5-tiny-q5_0",
  "hviske-v5-tiny-q4_k",
] as const;

/** The full production matrix: 18 Speech Models, in the order they are measured. */
export const CODICTATE_MODELS = [
  ...MULTILINGUAL_MODELS,
  ...DANISH_ONLY_MODELS,
] as const;

/**
 * Wall clock per second of audio for the Wispr Flow stage, **measured**.
 *
 * `1.482`, from the 1985 scored clips of
 * `results/20260902_181511_wispr-flow-all-400`: 8.16 h of wall clock over 5.51 h of
 * audio. The floor is 1.0 because the harness plays every clip through a virtual
 * microphone at real time; the rest is the lead silence, the tail, the response and the
 * 750 ms stability wait - 4.81 s per clip on that run.
 *
 * Used only to print an estimate. It is dated, and a property of one machine and one
 * Flow version, so it is stated as a measurement rather than treated as a constant.
 */
export const FLOW_WALL_OVER_AUDIO = 1.482;

/**
 * The models the `--smoke` chain rehearses, per SPEC §8.
 *
 * Deliberately **not** the production matrix. The smoke chain exists to prove the chain
 * works end to end; 30,000 clips is not a rehearsal.
 */
export const SMOKE_MODELS = ["large-v3-q5_0", "hviske-v5-tiny-q5_0"] as const;

/** Datasets a model can honestly be measured on. Absent means all five. */
const MODEL_DATASETS: Record<string, readonly DatasetId[]> = Object.fromEntries(
  DANISH_ONLY_MODELS.map((model) => [model, ["da_dk"] as readonly DatasetId[]]),
);

/**
 * Wispr Flow's dictation shortcut: Option+Z, per SPEC §5 and confirmed against the
 * installed product.
 *
 * Defined once in `src/publication-hotkey.ts` and re-exported here, so this
 * orchestrator and `src/runner.ts` cannot drift apart on it. The operator has to set
 * Flow's Hands-free shortcut to match, because Flow exposes no supported automation API
 * and nothing can verify it from this side: passing the wrong one does not error, it
 * times out on every clip. Which is why the value is echoed in the plan preview and
 * recorded in the batch manifest.
 */
export { DEFAULT_FLOW_HOTKEY };

// -- The batch manifest --

/** One (harness, model, dataset) slice of the matrix, as the manifest records it. */
export interface StagePlanRecord {
  dataset: DatasetId;
  /**
   * Seconds of audio the plan's scored clips hold, summed from the manifests.
   *
   * The denominator of every runtime estimate, and exact rather than estimated: the
   * harness plays Wispr Flow's clips at 1.0x real time, so this **is** the floor of the
   * Flow stage's wall clock, and a Codictate stage is this times its measured RTF.
   * Recorded on the manifest so a later invocation can state the remaining time without
   * rebuilding every manifest.
   */
  audioDurationSec: number;
  /** `fleurs/da_dk`, `librispeech/test-clean`. */
  datasetId: string;
  fromIndex: number;
  toIndex: number;
  clipCount: number;
  warmupCount: number;
  fingerprintV2: FingerprintV2;
}

/** One executable unit: one harness, one model, its datasets. */
export interface StageRecord {
  stageId: string;
  /** Execution order. Wispr Flow first, then the Codictate models. */
  order: number;
  harness: StageHarness;
  model: string;
  plans: StagePlanRecord[];
}

export interface BatchManifest {
  /** The batch manifest's own shape version, not the run record's. */
  manifestVersion: 1;
  batchId: string;
  mode: "production" | "smoke";
  createdAt: string;
  fromIndex: number;
  toIndex: number;
  flowHotkey: string;
  /**
   * The virtual audio device the batch plays through.
   *
   * On the manifest because it is a condition of the measurement, and compared on every
   * later invocation for the same reason `flowHotkey` is: neither can be verified from
   * this side, so a silent change is undetectable afterwards.
   */
  deviceName: string;
  /** Verbatim, per SPEC addendum §J. Printed on every surface that shows both products. */
  instrumentationNote: string;
  stages: StageRecord[];
}

export interface StageState {
  stageId: string;
  status: "pending" | "running" | "completed" | "failed";
  /** The Run this stage launched, so a later invocation resumes *that* run by id. */
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  lastError?: string;
  /** Per-dataset progress, contiguous cursor and gap-inclusive end kept apart. */
  progress?: Record<string, { cursor: number; maxMeasuredEnd: number; clipCount: number }>;
}

// -- CLI --

export interface PublicationOptions {
  batchId: string;
  fromIndex: number;
  toIndex: number;
  flowHotkey: Hotkey;
  smoke: boolean;
  clipsPerDataset?: number;
  /**
   * Where run directories live, and therefore which tree the cursors are derived from.
   *
   * Production runs go straight into `results/`, so they land in the same place every
   * committed run has ever landed and feed the production cursor. Smoke runs go into
   * `results/smoke/<batch>/`, which is git-ignored and skipped by every production scan
   * (`src/v2-record.ts::isSmokePath`) — the exclusion is a property of *where the run
   * is*, not of a flag someone has to remember to pass to the reader.
   */
  resultsRoot: string;
  /**
   * Where this batch's manifest, Run Plans, stage state and staging reports live.
   *
   * Separate from `resultsRoot` for production, because `results/` is a flat list of
   * run directories and putting the batch metadata in among them would make it look
   * like a run. `results/batches/<batch>/` has no `results.json`, so the v1 cursor scan
   * ignores it, and no v2 record, so the v2 scan ignores it too.
   */
  batchRoot: string;
  models: string[];
  datasets: DatasetId[];
  dryRun: boolean;
  /**
   * `--download-models`: fetch every missing weight and stop.
   *
   * A convenience, not a prerequisite. The production command fetches them itself, so
   * nobody has to have run this first; it exists because the download is the one long
   * step that can be done before committing an evening.
   */
  downloadOnly: boolean;
  /** `--preflight-only`: run the checks, print them, and stop. Fetches nothing. */
  preflightOnly: boolean;
  codictatePath: string;
  deviceName: string;
}

const DEFAULT_FROM = 0;
const DEFAULT_TO = 400;
/** The smoke chain's depth, per SPEC §8. Five scored clips from each dataset. */
const SMOKE_CLIPS_PER_DATASET = 5;

export function parsePublicationArgs(args: readonly string[]): PublicationOptions {
  let batchId: string | undefined;
  let fromIndex: number | undefined;
  let toIndex: number | undefined;
  let flowHotkey = DEFAULT_FLOW_HOTKEY;
  let smoke = false;
  let clipsPerDataset: number | undefined;
  let outRoot: string | undefined;
  let models: string[] | undefined;
  let datasets = [...DATASET_IDS] as DatasetId[];
  let dryRun = false;
  let downloadOnly = false;
  let preflightOnly = false;
  let codictatePath = resolve(import.meta.dir, "../../codictate");
  let deviceName = "BlackHole 2ch";

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = () => {
      const next = args[++index];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--batch": batchId = value(); break;
      case "--from": fromIndex = nonNegativeInteger(value(), flag); break;
      case "--to": toIndex = nonNegativeInteger(value(), flag); break;
      case "--flow-hotkey": flowHotkey = value(); break;
      case "--smoke": smoke = true; break;
      case "--clips-per-dataset": clipsPerDataset = positiveInteger(value(), flag); break;
      case "--out": outRoot = value(); break;
      case "--models": models = csv(value(), "--models"); break;
      case "--download-models": downloadOnly = true; break;
      case "--preflight-only": preflightOnly = true; break;
      case "--datasets": datasets = parseDatasets(value()); break;
      case "--dry-run": dryRun = true; break;
      case "--codictate": codictatePath = resolve(value()); break;
      case "--device": deviceName = value(); break;
      default:
        throw new Error(
          `Unknown flag: ${flag}. Accepted: --batch --from --to --flow-hotkey --smoke ` +
            `--clips-per-dataset --out --models --datasets --dry-run --codictate --device`,
        );
    }
  }

  if (!batchId) {
    throw new Error(
      "--batch <id> is required. It names the immutable shared batch manifest every stage " +
        "reads its range from, and it is how a second invocation finds the first one's plans " +
        "instead of building new ones.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(batchId)) {
    throw new Error(
      `--batch ${batchId} must be a directory-safe name: letters, digits, dot, dash, underscore.`,
    );
  }

  // `--smoke` fixes the depth, so a `--to` beside it would describe a different batch
  // from the one the smoke chain is specified as. `--clips-per-dataset` is how the
  // smoke depth is stated, and it defaults to the specified five.
  const perDataset = clipsPerDataset ?? (smoke ? SMOKE_CLIPS_PER_DATASET : undefined);
  const resolvedFrom = fromIndex ?? DEFAULT_FROM;
  const resolvedTo =
    perDataset !== undefined ? resolvedFrom + perDataset : (toIndex ?? DEFAULT_TO);
  if (toIndex !== undefined && perDataset !== undefined && toIndex !== resolvedTo) {
    throw new Error(
      `--to ${toIndex} and --clips-per-dataset ${perDataset} from --from ${resolvedFrom} ` +
        `describe different ranges (${toIndex} vs ${resolvedTo}). Pass one of them.`,
    );
  }
  if (resolvedTo <= resolvedFrom) {
    throw new Error(
      `--from ${resolvedFrom} --to ${resolvedTo} selects no clips. A batch with an empty range ` +
        `would write a manifest nothing can be measured against.`,
    );
  }

  // `--out` names the tree the batch lives under; the two roots derive from it, so a
  // smoke batch cannot be pointed at `results/` by forgetting a flag.
  const root = outRoot ? resolve(outRoot) : resolve(import.meta.dir, "../results");
  const resultsRoot = smoke ? join(root, "smoke", batchId) : root;
  const batchRoot = smoke ? join(root, "smoke") : join(root, "batches");

  return {
    batchId,
    fromIndex: resolvedFrom,
    toIndex: resolvedTo,
    flowHotkey: parseHotkey(flowHotkey),
    smoke,
    ...(perDataset === undefined ? {} : { clipsPerDataset: perDataset }),
    resultsRoot,
    batchRoot,
    // `--smoke` rehearses the chain with two models, per SPEC §8; a production batch
    // measures the whole matrix. An explicit `--models` wins over both.
    models: models ?? (smoke ? [...SMOKE_MODELS] : [...CODICTATE_MODELS]),
    datasets,
    dryRun,
    downloadOnly,
    preflightOnly,
    codictatePath,
    deviceName,
  };
}

// -- Matrix --

/**
 * The stages, in production order: **Wispr Flow first, then the Codictate models.**
 *
 * A stage per (harness, model) rather than per (harness, model, dataset), because that
 * is what one CLI invocation covers and therefore what can be resumed or skipped as a
 * unit. Each stage still carries one fingerprinted Run Plan per dataset, since a
 * fingerprint is over one dataset's clip list.
 */
export function stageMatrix(
  options: PublicationOptions,
  manifests: ReadonlyMap<DatasetId, ManifestEntry[]>,
  createdAt: string,
): StageRecord[] {
  const stages: StageRecord[] = [];
  let order = 0;

  const push = (harness: StageHarness, model: string, datasets: readonly DatasetId[]): void => {
    const plans = datasets
      .filter((dataset) => options.datasets.includes(dataset))
      .map((dataset) => planRecordFor(options, manifests, harness, model, dataset, createdAt))
      .filter((plan): plan is StagePlanRecord => plan !== null);
    if (plans.length === 0) return;
    stages.push({ stageId: stageIdOf(harness, model), order: order++, harness, model, plans });
  };

  // Wispr Flow first. It is the product that can change underneath the measurement.
  push("wispr-flow", "wispr-flow", options.datasets);
  for (const model of options.models) {
    push("codictate", model, MODEL_DATASETS[model] ?? options.datasets);
  }
  return stages;
}

export function stageIdOf(harness: StageHarness, model: string): string {
  return harness === "codictate" ? `codictate-${model}` : "wispr-flow";
}

function planRecordFor(
  options: PublicationOptions,
  manifests: ReadonlyMap<DatasetId, ManifestEntry[]>,
  harness: StageHarness,
  model: string,
  dataset: DatasetId,
  createdAt: string,
): StagePlanRecord | null {
  const entries = manifests.get(dataset);
  if (!entries) return null;
  const consumableCount = consumableEntries(entries).length;
  if (options.fromIndex >= consumableCount) {
    throw new Error(
      `--from ${options.fromIndex} is past the end of ${dataset}, which has ${consumableCount} ` +
        `consumable clips (${entries.length} minus the ${WARMUP_COUNT} reserved warmups).`,
    );
  }
  // Clamped **only** at the end of the corpus, and reported as a short plan rather
  // than silently: a dataset with 300 clips left under `--to 400` is complete at 300,
  // and refusing the whole batch for that would abort a night that could still measure
  // the other four datasets.
  const toIndex = Math.min(options.toIndex, consumableCount);
  const plan = planFor(options, entries, harness, model, dataset, createdAt, toIndex);
  const scoredEntries = consumableEntries(entries).slice(plan.fromIndex, plan.toIndex);
  return {
    dataset,
    datasetId: plan.datasetId,
    fromIndex: plan.fromIndex,
    toIndex: plan.toIndex,
    clipCount: plan.orderedClipIds.length,
    warmupCount: plan.warmupClipIds.length,
    audioDurationSec: scoredEntries.reduce((total, entry) => total + entry.audioDurationSec, 0),
    fingerprintV2: plan.fingerprintV2,
  };
}

function planFor(
  options: PublicationOptions,
  entries: readonly ManifestEntry[],
  harness: StageHarness,
  model: string,
  dataset: DatasetId,
  createdAt: string,
  toIndex: number,
): RunPlan {
  return runPlanFor({
    runId: `${options.batchId}_${stageIdOf(harness, model)}_${dataset}`,
    batchId: options.batchId,
    harness,
    model,
    dataset,
    entries,
    fromIndex: options.fromIndex,
    toIndex,
    createdAt,
  });
}

// -- Batch directory --

export function batchDir(options: PublicationOptions): string {
  return join(options.batchRoot, options.batchId);
}

export function manifestPath(options: PublicationOptions): string {
  return join(batchDir(options), "batch.json");
}

function stageStatePath(options: PublicationOptions, stageId: string): string {
  return join(batchDir(options), "stages", `${stageId}.json`);
}

function stagePlanPath(options: PublicationOptions, stageId: string, dataset: string): string {
  return join(batchDir(options), "plans", stageId, `${dataset}.json`);
}

/**
 * Read the batch manifest if it exists, otherwise build it and write it **once**.
 *
 * The immutability is the whole point. A second invocation must measure the clips the
 * first one planned, not the clips today's cursor would pick, because the comparison
 * being published is between products over one clip set. An existing manifest whose
 * stage fingerprints disagree with what this invocation would build is refused with
 * both fingerprints named — that means the corpus or the flags moved, and continuing
 * would file the second half of a comparison against a different sample from the first.
 */
export function loadOrCreateBatchManifest(
  options: PublicationOptions,
  manifests: ReadonlyMap<DatasetId, ManifestEntry[]>,
  createdAt: string,
): { manifest: BatchManifest; created: boolean } {
  const path = manifestPath(options);
  const provisionalStages = stageMatrix(options, manifests, createdAt);
  let effectiveCreatedAt = createdAt;
  if (!existsSync(path)) {
    for (const stage of provisionalStages) {
      for (const record of stage.plans) {
        const existing = readRunPlan(stagePlanPath(options, stage.stageId, record.dataset));
        if (existing) {
          effectiveCreatedAt = existing.createdAt;
          break;
        }
      }
      if (effectiveCreatedAt !== createdAt) break;
    }
  }
  const stages = stageMatrix(options, manifests, effectiveCreatedAt);
  const fresh: BatchManifest = {
    manifestVersion: 1,
    batchId: options.batchId,
    mode: options.smoke ? "smoke" : "production",
    createdAt: effectiveCreatedAt,
    fromIndex: options.fromIndex,
    toIndex: options.toIndex,
    flowHotkey: options.flowHotkey.spec,
    deviceName: options.deviceName,
    instrumentationNote: INSTRUMENTATION_ASYMMETRY_LABEL,
    stages,
  };

  if (existsSync(path)) {
    const existing = JSON.parse(readFileSync(path, "utf8")) as BatchManifest;
    assertManifestsAgree(existing, fresh, path);
    ensureBatchPlans(options, manifests, existing);
    return { manifest: existing, created: false };
  }

  mkdirSync(batchDir(options), { recursive: true });
  // Plans commit before the manifest. A manifest therefore never advertises files
  // that were not durably written; an interrupted first write is recovered on retry.
  ensureBatchPlans(options, manifests, fresh);
  writeJsonAtomic(path, fresh);
  return { manifest: fresh, created: true };
}

function ensureBatchPlans(
  options: PublicationOptions,
  manifests: ReadonlyMap<DatasetId, ManifestEntry[]>,
  manifest: BatchManifest,
): void {
  for (const stage of manifest.stages) {
    mkdirSync(join(batchDir(options), "plans", stage.stageId), { recursive: true });
    for (const record of stage.plans) {
      const entries = manifests.get(record.dataset)!;
      const plan = planFor(
        options,
        entries,
        stage.harness,
        stage.model,
        record.dataset,
        manifest.createdAt,
        record.toIndex,
      );
      const path = stagePlanPath(options, stage.stageId, record.dataset);
      const existing = readRunPlan(path);
      if (existing) {
        const expectedRunId = `${options.batchId}_${stage.stageId}_${record.dataset}`;
        if (
          existing.fingerprintV2.value !== record.fingerprintV2.value ||
          existing.runId !== expectedRunId ||
          existing.batchId !== options.batchId ||
          existing.harness !== stage.harness ||
          existing.model !== stage.model ||
          existing.datasetId !== record.datasetId ||
          existing.fromIndex !== record.fromIndex ||
          existing.toIndex !== record.toIndex ||
          existing.createdAt !== manifest.createdAt
        ) {
          throw new Error(
            `Run Plan ${path} disagrees with batch manifest identity or selection.`,
          );
        }
        continue;
      }
      writeJsonAtomic(path, plan);
    }
  }
}

function assertManifestsAgree(existing: BatchManifest, fresh: BatchManifest, path: string): void {
  const differences: string[] = [];
  if (existing.mode !== fresh.mode) {
    differences.push(`mode ${existing.mode} vs ${fresh.mode}`);
  }
  if (existing.fromIndex !== fresh.fromIndex || existing.toIndex !== fresh.toIndex) {
    differences.push(
      `range [${existing.fromIndex}, ${existing.toIndex}) vs [${fresh.fromIndex}, ${fresh.toIndex})`,
    );
  }
  // The two conditions nothing on this side can verify. A second invocation with a
  // different `--flow-hotkey` previewed the manifest's value while actually running the
  // new one, so the manifest and the run record disagreed about the one term whose
  // mismatch produces silence and timeouts rather than an error.
  if (existing.flowHotkey !== fresh.flowHotkey) {
    differences.push(`flowHotkey ${existing.flowHotkey} vs ${fresh.flowHotkey}`);
  }
  if ((existing.deviceName ?? fresh.deviceName) !== fresh.deviceName) {
    differences.push(`deviceName ${existing.deviceName} vs ${fresh.deviceName}`);
  }

  // **Both directions over the stage list.** Iterating only `fresh.stages` caught a
  // widening flag and silently discarded a narrowing one: `--datasets da_dk` against an
  // existing five-dataset batch ran all five, because the four extra stages were only
  // in `existing` and nothing looked there. A narrowing flag is a plan the operator
  // typed and did not get.
  const existingStages = new Map(existing.stages.map((stage) => [stage.stageId, stage]));
  const freshStages = new Map(fresh.stages.map((stage) => [stage.stageId, stage]));
  for (const stage of fresh.stages) {
    const previous = existingStages.get(stage.stageId);
    if (!previous) {
      differences.push(`stage ${stage.stageId} is new in this invocation`);
      continue;
    }
    for (const plan of stage.plans) {
      const before = previous.plans.find((entry) => entry.dataset === plan.dataset);
      if (!before) {
        differences.push(`${stage.stageId}/${plan.dataset} is new in this invocation`);
        continue;
      }
      if (before.fingerprintV2.value !== plan.fingerprintV2.value) {
        differences.push(
          `${stage.stageId}/${plan.dataset} fingerprint ${before.fingerprintV2.value} vs ` +
            `${plan.fingerprintV2.value}`,
        );
      }
    }
  }
  for (const stage of existing.stages) {
    const now = freshStages.get(stage.stageId);
    if (!now) {
      differences.push(`stage ${stage.stageId} is in the manifest but not in this invocation`);
      continue;
    }
    for (const plan of stage.plans) {
      if (!now.plans.some((entry) => entry.dataset === plan.dataset)) {
        differences.push(
          `${stage.stageId}/${plan.dataset} is in the manifest but not in this invocation`,
        );
      }
    }
  }
  if (differences.length === 0) return;
  throw new Error(
    `Batch manifest ${path} already exists and describes a different batch:\n` +
      differences.map((line) => `  - ${line}`).join("\n") +
      `\n\nA batch manifest is immutable: the measurements already filed under it belong to its ` +
      `clips and were taken under its conditions. Either drop the flags that changed and ` +
      `re-run, or start a new batch with a new --batch id. This includes **narrowing** a batch ` +
      `- \`--datasets da_dk\` against a five-dataset manifest is refused rather than quietly ` +
      `running all five, because a plan the operator typed and did not get is worse than an ` +
      `error. To measure a subset, start a new batch id for it.`,
  );
}

// -- Execution --

interface StageOutcome {
  stage: StageRecord;
  decision: "skip-completed" | "run" | "resume";
  state: StageState;
}

/**
 * What to do with one stage: skip it, run it, or resume the run it already started.
 *
 * Read from the records on disk rather than from the stage state file, so a stage
 * cannot be marked complete by a state file that outlived the measurements. The state
 * file records *which run* was launched, which is the one thing the records cannot say.
 */
export function stageDecision(
  options: PublicationOptions,
  stage: StageRecord,
  records: readonly ScannedV2Record[],
): StageOutcome {
  const state = readStageState(options, stage.stageId);
  const progress: NonNullable<StageState["progress"]> = {};
  let complete = true;

  for (const record of stage.plans) {
    const plan = readRunPlan(stagePlanPath(options, stage.stageId, record.dataset));
    if (!plan) {
      complete = false;
      progress[record.dataset] = { cursor: 0, maxMeasuredEnd: 0, clipCount: record.clipCount };
      continue;
    }
    // One pass over the records per dataset, and the completeness question answered
    // from that pass rather than from a second walk. `v2CursorFor` matches a record to
    // this plan on `compatibilityKey` **and** fingerprint, so another product's records
    // over the same clips cannot complete this stage.
    const cursor = v2CursorFor(plan, records);
    progress[record.dataset] = {
      cursor: cursor.cursor,
      maxMeasuredEnd: cursor.maxMeasuredEnd,
      clipCount: plan.orderedClipIds.length,
    };
    if (!isStageComplete(plan, records, cursor)) complete = false;
  }

  const next: StageState = { ...state, progress };
  if (complete) {
    return { stage, decision: "skip-completed", state: { ...next, status: "completed" } };
  }
  const discoveredRunId = state.runId ?? runIdForStage(stage, records, options.batchId);
  const started = Object.values(progress).some((entry) => entry.cursor > 0) || discoveredRunId;
  return {
    stage,
    decision: started ? "resume" : "run",
    state: discoveredRunId ? { ...next, runId: discoveredRunId } : next,
  };
}

function readStageState(options: PublicationOptions, stageId: string): StageState {
  const path = stageStatePath(options, stageId);
  if (!existsSync(path)) return { stageId, status: "pending", attempts: 0 };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StageState;
  } catch {
    return { stageId, status: "pending", attempts: 0 };
  }
}

function saveStageState(options: PublicationOptions, state: StageState): void {
  mkdirSync(join(batchDir(options), "stages"), { recursive: true });
  writeJsonAtomic(stageStatePath(options, state.stageId), state);
}

/**
 * The command a stage runs, as an argv array.
 *
 * Built rather than templated into a string, so nothing is quoted twice and a dataset
 * name with a space in it could never become two arguments. Exported because the
 * `--dry-run` prints it verbatim: the whole value of a dry run is that a human can read
 * the command that *would* have run and recognise it.
 *
 * `--to` rather than `--samples` in both harnesses, deliberately. `--samples` is a
 * delta from a cursor, so running it twice measures twice; `--to` is a target depth and
 * a no-op where the depth is reached, which is exactly what makes re-running the batch
 * command safe.
 */
export function stageCommand(
  options: PublicationOptions,
  stage: StageRecord,
  resumeRunId?: string,
): string[] {
  const description =
    `benchmark-v2 publication batch ${options.batchId}` +
    (options.smoke ? " (smoke)" : "") +
    `; ${stage.harness} ${stage.model}; clips [${options.fromIndex}, ${options.toIndex}) ` +
    `of the consumable range; hotkey ${options.flowHotkey.spec}`;

  if (stage.harness === "wispr-flow") {
    if (resumeRunId) {
      // A resume names the run and passes nothing that could change its selection.
      // `--batch` and `--out` are the two flags deliberately allowed beside it.
      return [
        "bun",
        "run",
        "src/runner.ts",
        "--resume",
        resumeRunId,
        "--batch",
        options.batchId,
        "--out",
        options.resultsRoot,
        // Kept, because a resumed run has to find the audio it has left to play and a
        // committed record stores `<codictate>` as a placeholder. A batch launched with
        // `--codictate /elsewhere` that resumed against the sibling default would fail
        // loudly if the corpora differed - and a resume the operator cannot issue does
        // not work either way. Not a selection-changing flag: it names where the clips
        // live, not which clips they are.
        "--codictate",
        options.codictatePath,
      ];
    }
    return [
      "bun",
      "run",
      "src/runner.ts",
      "--name",
      `${options.batchId}-flow`,
      "--batch",
      options.batchId,
      "--out",
      options.resultsRoot,
      "--datasets",
      stage.plans.map((plan) => plan.dataset).join(","),
      "--from",
      String(options.fromIndex),
      "--to",
      String(options.toIndex),
      "--flow-hotkey",
      options.flowHotkey.spec,
      "--codictate",
      options.codictatePath,
      "--device",
      options.deviceName,
      "--configuration-note",
      description,
    ];
  }

  // A Codictate stage resumes by run **directory name** under its own results tree
  // (SPEC addendum §U), and a same-`--name` re-run now refuses rather than continuing,
  // so a resume that fell through to the fresh command wedged the batch permanently:
  // stop-on-first-failure threw on every subsequent invocation with no way out but
  // hand-editing. `--batch` and `--out` are the two flags §G deliberately allows beside
  // a resume, which is why both harnesses can be driven the same way.
  if (resumeRunId) {
    return [
      "bun",
      "run",
      "bench:stt",
      "--",
      "--resume",
      resumeRunId,
      "--batch",
      options.batchId,
      "--out",
      codictateResultsRoot(options),
    ];
  }

  const splits = stage.plans
    .map((plan) => plan.dataset)
    .filter((dataset) => dataset.startsWith("test-"));
  const languages = stage.plans
    .map((plan) => plan.dataset)
    .filter((dataset) => !dataset.startsWith("test-"));
  return [
    "bun",
    "run",
    "bench:stt",
    "--",
    "--name",
    codictateRunName(options.batchId, stage.model),
    "--description",
    description,
    // Always. It is what puts `batchId` on the v2 record, which is the only way a later
    // invocation can find the run id to resume this stage by - `runIdForStage` matches
    // on it, and without it `state.runId` stayed `undefined` for ever.
    "--batch",
    options.batchId,
    // Smoke output must not land in Codictate's production results tree. Without this
    // the SPEC §8 exclusion held for the Wispr Flow half only: five rehearsal clips per
    // dataset became ordinary completed v2 records in `codictate/benchmarks/results/`,
    // fed `poolSamples`, and advanced the cursor the production batch measures from.
    "--out",
    codictateResultsRoot(options),
    "--models",
    stage.model,
    // `none` is how a language-pinned model is measured honestly: hviske transcribes
    // as Danish whatever it is handed, so an English split would measure Danish
    // decoding of English speech rather than the model.
    "--splits",
    splits.length > 0 ? splits.join(",") : "none",
    "--languages",
    languages.length > 0 ? languages.join(",") : "none",
    "--from",
    String(options.fromIndex),
    "--to",
    String(options.toIndex),
    // Never offload. A resumed stage would re-download a gigabyte and charge it to the
    // first clip's wall time.
    "--skip-download",
  ];
}

/** Codictate accepts lowercase alphanumerics separated by single hyphens. */
export function codictateRunName(batchId: string, model: string): string {
  const value = `${batchId}-${model}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!value) throw new Error(`Cannot derive a Codictate run name from ${batchId}/${model}`);
  return value;
}

/**
 * Where Codictate stages of this batch write their run directories.
 *
 * A production batch writes into Codictate's own tree, because that is where its cursor,
 * its aggregation and its reports look. A **smoke** batch must not: its five rehearsal
 * clips per dataset are indistinguishable from production measurements once they are
 * ordinary completed v2 records in that tree, and they would advance the cursor the
 * production batch later measures from. So a smoke batch redirects them under this
 * batch's own git-ignored directory, which is the same guarantee `--out` gives the
 * Wispr Flow half.
 */
export function codictateResultsRoot(options: PublicationOptions): string {
  return options.smoke
    ? join(batchDir(options), "codictate-results")
    : join(options.codictatePath, "benchmarks", "results");
}

/**
 * Every v2 record either harness may have written for this batch.
 *
 * Two trees, because the two harnesses own their own output: this repository's runs are
 * under `resultsRoot`, and Codictate writes into `<codictate>/benchmarks/results`. A
 * stage's completion has to be read from wherever its own harness put its records, or a
 * finished Codictate stage would look permanently unmeasured and be re-run every night.
 *
 * `includeSmoke` is on only for a smoke batch, which reads its own tree by design. A
 * production read never sees `results/smoke/`.
 */
export function collectRecords(options: PublicationOptions): ScannedV2Record[] {
  return [
    ...scanRunRecordsV2(options.resultsRoot, { includeSmoke: options.smoke }),
    // Wherever this batch's Codictate stages were told to write: its own tree for a
    // production batch, the batch's git-ignored directory for a smoke one.
    ...scanRunRecordsV2(codictateResultsRoot(options), { includeSmoke: options.smoke }),
  ];
}

/**
 * The run id this batch's records attribute to a stage, newest first.
 *
 * Read off the records rather than remembered from a log line, because the records are
 * what a later invocation actually has. Matched on `(batchId, harness, model)`: the
 * batch id is on every record the orchestrator's stages write (`--batch` reaches the
 * run config, which reaches the v2 record), so a run from another batch over the same
 * clips cannot be mistaken for this stage's.
 */
export function runIdForStage(
  stage: StageRecord,
  records: readonly ScannedV2Record[],
  batchId: string,
): string | undefined {
  const matches = records
    .map(({ record }) => record)
    .filter(
      (record) =>
        record.batchId === batchId &&
        record.harness === stage.harness &&
        record.model === stage.model,
    )
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return matches[0]?.runId;
}

/**
 * An argv array as a line a human can paste.
 *
 * The commands are spawned as argv, so quoting is irrelevant to execution - and the
 * whole value of `--dry-run` is that a human reads the command that *would* have run
 * and recognises it. `--device BlackHole 2ch` printed unquoted is two arguments to the
 * reader's eye and one to the spawn, and the `--configuration-note` carries semicolons.
 * Anything not obviously safe is single-quoted.
 */
export function shellQuote(argv: readonly string[]): string {
  return argv
    .map((token) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token) ? token : `'${token.replace(/'/g, "'\\''")}'`))
    .join(" ");
}

/**
 * The Speech Models the stages that still have work actually need.
 *
 * A completed stage's weights are not fetched again: on a resumed batch that is the
 * difference between a few hundred megabytes and twenty gigabytes. Wispr Flow is not a
 * Speech Model and contributes nothing here.
 */
export function modelsNeededBy(outcomes: readonly { stage: StageRecord; decision: string }[]): string[] {
  const needed: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.decision === "skip-completed") continue;
    if (outcome.stage.harness !== "codictate") continue;
    if (!needed.includes(outcome.stage.model)) needed.push(outcome.stage.model);
  }
  return needed;
}

/**
 * One preflight check per Speech Model the batch needs.
 *
 * A missing but fetchable weight is **not** a failure: the batch downloads it before the
 * first clip, so refusing to start would make the single-command promise false. A
 * missing weight the batch *cannot* fetch is a failure with the remedy - Parakeet's
 * Core ML bundle is installed by the Codictate app, not by a file fetch, and
 * `bench:stt`'s own download step skips it for the same reason.
 */
function modelInventoryChecks(inventory: readonly ModelStatus[]): Check[] {
  return inventory.map((status) => ({
    id: `model-${status.id}`,
    label: `Speech Model: ${status.id}`,
    status: status.present ? "ok" : status.downloadable ? "ok" : "failed",
    detail: status.present
      ? `on disk (${status.artifactName})`
      : status.downloadable
        ? `will be downloaded before the first clip, ${status.downloadSizeMB} MB (${status.artifactName})`
        : `missing, and engine ${status.engine} is not downloadable by this batch`,
    ...(status.present || status.downloadable
      ? {}
      : {
          remedy:
            `Install ${status.id} through the Codictate app - a ${status.engine} bundle is not a ` +
            `file this batch can fetch - or drop it from the matrix with --models.`,
        }),
  }));
}

/** The results tree a stage's own harness writes its run directories into. */
export function stageResultsRoot(options: PublicationOptions, stage: StageRecord): string {
  return stage.harness === "codictate"
    ? codictateResultsRoot(options)
    : options.resultsRoot;
}

/**
 * The command that resumes one stage by hand, printed whenever the orchestrator cannot
 * do it itself.
 *
 * Both harnesses take `--resume <runId> --batch <id> --out <dir>` - the run id plus the
 * two flags SPEC addendum §G deliberately allows beside a resume - so one shape covers
 * both and an operator does not have to remember which repository spells it differently.
 */
export function manualResumeCommand(
  options: PublicationOptions,
  stage: StageRecord,
  runId: string,
): string[] {
  return stage.harness === "codictate"
    ? [
        "bun",
        "run",
        "bench:stt",
        "--",
        "--resume",
        runId,
        "--batch",
        options.batchId,
        "--out",
        codictateResultsRoot(options),
      ]
    : [
        "bun",
        "run",
        "benchmark",
        "--",
        "--resume",
        runId,
        "--batch",
        options.batchId,
        "--out",
        options.resultsRoot,
        "--codictate",
        options.codictatePath,
      ];
}

function manualResumeLine(options: PublicationOptions, stage: StageRecord, runId: string): string {
  const command = shellQuote(manualResumeCommand(options, stage, runId));
  return stage.harness === "codictate"
    ? `${command}\n    # run from ${options.codictatePath}`
    : command;
}

export function assertStageCompletedAfterExit(stageId: string, decision: StageOutcome["decision"]): void {
  if (decision !== "skip-completed") {
    throw new Error(
      `[${stageId}] exited 0 but did not complete every planned record. ` +
        `Stopping rather than continuing with a comparison hole.`,
    );
  }
}

/** Where a stage's command runs. Codictate stages run in the Codictate checkout. */
function stageCwd(options: PublicationOptions, stage: StageRecord): string {
  return stage.harness === "codictate"
    ? options.codictatePath
    : resolve(import.meta.dir, "..");
}

// -- Reporting --

function readinessReport(
  options: PublicationOptions,
  manifest: BatchManifest,
  outcomes: readonly StageOutcome[],
  checks: readonly Check[],
): string {
  const lines: string[] = [];
  lines.push(`# Publication batch readiness: ${manifest.batchId}`);
  lines.push("");
  lines.push(`**Staging only. Nothing here has been published or deployed.**`);
  lines.push("");
  lines.push(`- Mode: ${manifest.mode}`);
  lines.push(`- Range: consumable clips [${manifest.fromIndex}, ${manifest.toIndex})`);
  lines.push(`- Warmup Reservation: ${WARMUP_COUNT} clips per dataset, replayed every session, never scored`);
  lines.push(`- Wispr Flow hotkey: ${manifest.flowHotkey}`);
  lines.push(`- Created: ${manifest.createdAt}`);
  lines.push("");
  lines.push(`> ${manifest.instrumentationNote}`);
  lines.push("");
  lines.push("## Stages");
  lines.push("");
  lines.push("| # | Stage | Datasets | Scored clips | Measured | Status |");
  lines.push("| - | ----- | -------- | ------------ | -------- | ------ |");
  for (const outcome of outcomes) {
    const planned = outcome.stage.plans.reduce((total, plan) => total + plan.clipCount, 0);
    const measured = Object.values(outcome.state.progress ?? {}).reduce(
      (total, entry) => total + entry.cursor,
      0,
    );
    lines.push(
      `| ${outcome.stage.order + 1} | ${outcome.stage.harness} ${outcome.stage.model} | ` +
        `${outcome.stage.plans.length} | ${planned} | ${measured} | ${outcome.state.status} |`,
    );
  }
  lines.push("");
  lines.push("## Clip selection fingerprints");
  lines.push("");
  lines.push("| Stage | Dataset | Range | Clips | fingerprintV2 |");
  lines.push("| ----- | ------- | ----- | ----- | ------------- |");
  for (const stage of manifest.stages) {
    for (const plan of stage.plans) {
      lines.push(
        `| ${stage.stageId} | ${plan.datasetId} | [${plan.fromIndex}, ${plan.toIndex}) | ` +
          `${plan.clipCount} | \`${plan.fingerprintV2.value}\` |`,
      );
    }
  }
  lines.push("");
  lines.push("## Preflight");
  lines.push("");
  lines.push("```");
  lines.push(formatChecks(checks));
  lines.push("```");
  lines.push("");
  lines.push("## What this batch is not");
  lines.push("");
  lines.push(
    "- Not published. Promotion of v2 numbers to the leaderboard is a separate human decision.",
  );
  lines.push("- Not deployed. No site build, no upload, no release.");
  lines.push("- Models are left on disk. Nothing is offloaded.");
  if (manifest.mode === "smoke") {
    lines.push(
      "- Smoke output is git-ignored and excluded from the production cursor, aggregation, " +
        "coverage, staging and publication.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

// -- main --

function printPlan(
  options: PublicationOptions,
  manifest: BatchManifest,
  outcomes: readonly StageOutcome[],
): void {
  console.log(`Batch:     ${manifest.batchId} (${manifest.mode})`);
  console.log(`Range:     consumable clips [${manifest.fromIndex}, ${manifest.toIndex}) per dataset`);
  console.log(`Warmups:   ${WARMUP_COUNT} per dataset, replayed every session, never scored, never consumed`);
  console.log(`Hotkey:    ${manifest.flowHotkey} (set Wispr Flow's Hands-free shortcut to match)`);
  console.log(`Out:       ${batchDir(options)}`);
  console.log(`Manifest:  ${manifestPath(options)}`);
  console.log(`Publishes: nothing. Staging reports only, models left on disk.`);
  console.log("");
  console.log(manifest.instrumentationNote);
  console.log("");
  console.log("Stages, in production order (Wispr Flow first, then Codictate models):");
  for (const outcome of outcomes) {
    const { stage, decision, state } = outcome;
    const planned = stage.plans.reduce((total, plan) => total + plan.clipCount, 0);
    const measured = Object.values(state.progress ?? {}).reduce(
      (total, entry) => total + entry.cursor,
      0,
    );
    const verdict =
      decision === "skip-completed"
        ? "SKIP (completed)"
        : decision === "resume"
          ? `RESUME (${measured}/${planned} scored clips measured)`
          : "RUN";
    console.log("");
    console.log(`  ${stage.order + 1}. ${stage.harness} ${stage.model} -> ${verdict}`);
    for (const plan of stage.plans) {
      const progress = state.progress?.[plan.dataset];
      const done = progress?.cursor ?? 0;
      const gapNote =
        progress && progress.maxMeasuredEnd > progress.cursor
          ? `, maxMeasuredEnd ${progress.maxMeasuredEnd} (not contiguous, not a depth)`
          : "";
      console.log(
        `       ${plan.datasetId.padEnd(26)} clips [${plan.fromIndex}, ${plan.toIndex}) = ` +
          `${plan.clipCount} scored + ${plan.warmupCount} warmup replays; ` +
          `measured ${done}/${plan.clipCount}${gapNote}; fingerprintV2 ${plan.fingerprintV2.value}`,
      );
    }
    const command = stageCommand(
      options,
      stage,
      decision === "resume" ? (state.runId ?? "<runId recorded when the stage first ran>") : undefined,
    );
    if (decision !== "skip-completed") {
      console.log(`       $ ${shellQuote(command)}`);
      console.log(`         (cwd ${stageCwd(options, stage)})`);
    }
  }

  const totalScored = manifest.stages.reduce(
    (total, stage) => total + stage.plans.reduce((sum, plan) => sum + plan.clipCount, 0),
    0,
  );
  const remaining = outcomes
    .filter((outcome) => outcome.decision !== "skip-completed")
    .reduce((total, outcome) => {
      const planned = outcome.stage.plans.reduce((sum, plan) => sum + plan.clipCount, 0);
      const measured = Object.values(outcome.state.progress ?? {}).reduce(
        (sum, entry) => sum + entry.cursor,
        0,
      );
      return total + planned - measured;
    }, 0);
  const totalAudioSec = manifest.stages.reduce(
    (total, stage) => total + stage.plans.reduce((sum, plan) => sum + (plan.audioDurationSec ?? 0), 0),
    0,
  );
  const flowAudioSec =
    manifest.stages
      .find((stage) => stage.harness === "wispr-flow")
      ?.plans.reduce((sum, plan) => sum + (plan.audioDurationSec ?? 0), 0) ?? 0;
  console.log("");
  console.log(`Total:     ${totalScored} scored clips across ${manifest.stages.length} stages`);
  console.log(`Audio:     ${(totalAudioSec / 3600).toFixed(2)} h summed over every stage`);
  if (flowAudioSec > 0) {
    // The one stage whose wall clock is bounded from below by real time: the harness
    // plays every clip through a virtual microphone at 1.0x. The ratio is measured from
    // the archived 400-clip run, not assumed.
    console.log(
      `Flow stage: ${(flowAudioSec / 3600).toFixed(2)} h of audio at 1.0x playback, so at ` +
        `least that long; the archived run measured ${FLOW_WALL_OVER_AUDIO}x wall over audio, ` +
        `about ${((flowAudioSec / 3600) * FLOW_WALL_OVER_AUDIO).toFixed(1)} h`,
    );
  }
  console.log(`To run:    ${remaining} scored clips remain (0 means every stage is complete)`);
}

async function main(): Promise<void> {
  const options = parsePublicationArgs(process.argv.slice(2));
  const datasetsDir = datasetsRoot(options.codictatePath);
  const createdAt = new Date().toISOString();

  // Preflight before anything is built, so a missing corpus is one message rather than
  // a stack trace out of `buildManifest`.
  const preflightOptions = {
    codictatePath: options.codictatePath,
    deviceName: options.deviceName,
    datasets: options.datasets,
    batchId: options.batchId,
    // The models are checked by `modelInventoryChecks` below, against the Codictate
    // catalogue, so `repositoryChecks` is not asked to guess at artifact names.
    resultsRoot: options.resultsRoot,
    // A smoke batch writes into a fresh tree, so a check scoped to it would always pass
    // and would say nothing about the tree the production batch is going to use.
    ...(options.smoke
      ? { alsoCheckResultsRoots: [resolve(import.meta.dir, "../results")] }
      : {}),
  };
  // The model inventory is read first, because two preflight checks depend on it: the
  // per-model verdict, and the free-disk figure - which has to be measured against what
  // the batch is about to fetch rather than against a fixed 5 GiB. An 18-model matrix
  // needs roughly 20 GB of weights.
  let inventory: ModelStatus[] = [];
  let inventoryError: string | undefined;
  try {
    inventory = await modelInventory(options.codictatePath, options.models);
  } catch (error) {
    inventoryError = error instanceof Error ? error.message : String(error);
  }
  const pendingMB = pendingDownloadMB(inventory);
  const modelChecks: Check[] = inventoryError
    ? [
        {
          id: "model-catalogue",
          label: "Speech Model catalogue",
          status: "failed",
          detail: inventoryError,
          remedy:
            "Point --codictate at a Codictate checkout with its dependencies installed " +
            "(`bun install` there). The batch reads the catalogue and the downloader from that " +
            "checkout rather than carrying copies, so it fetches the weights the run will " +
            "actually load.",
        },
      ]
    : modelInventoryChecks(inventory);

  const preflightOptionsWithDisk = {
    ...preflightOptions,
    // Headroom on top of the weights: the run records, the reports, and the slack a
    // filesystem needs to not fail a rename at 99%.
    minimumFreeBytes: Math.round((pendingMB + 2_048) * 1024 * 1024),
  };
  const checks = [
    ...(options.dryRun
      ? repositoryChecks(preflightOptionsWithDisk)
      : await allChecks(preflightOptionsWithDisk)),
    ...modelChecks,
  ];
  console.log(options.dryRun ? "Preflight (repository checks only; --dry-run)" : "Preflight");
  console.log(formatChecks(checks));
  const failed = failures(checks);
  if (failed.length > 0) {
    console.log("");
    if (options.dryRun) {
      // Advisory under --dry-run: a dry run is the one thing a human can safely run to
      // check the plan, and refusing it because Wispr Flow is not open yet would make
      // it useless for that. A real run aborts.
      console.log(
        `${failed.length} check(s) failed. Under --dry-run this is advisory; a real run stops ` +
          `here. Fix them before the first pass.`,
      );
    } else {
      console.error("");
      console.error(
        `Refusing to start: ${failed.length} preflight check(s) failed ` +
          `(${failed.map((check) => check.id).join(", ")}). Each one is listed above with what ` +
          `to do about it. An overnight batch is hours of real-time playback, so a check that ` +
          `fires on clip 900 has already cost the night.`,
      );
      process.exitCode = 1;
      return;
    }
  }
  if (inventory.length > 0) {
    console.log("");
    console.log(
      pendingMB === 0
        ? `Speech Models: all ${inventory.length} on disk. Nothing to download.`
        : `Speech Models: ${inventory.filter((m) => m.present).length}/${inventory.length} on ` +
          `disk; ${(pendingMB / 1024).toFixed(1)} GB to fetch before the first clip.`,
    );
  }
  console.log("");

  if (options.preflightOnly) {
    console.log(
      "--preflight-only: nothing was fetched and nothing was measured. Fix any FAIL above, " +
        "then run the batch command - it downloads the weights itself.",
    );
    return;
  }

  if (options.downloadOnly) {
    // The convenience path. The batch command does this itself, so nobody has to have
    // run this first; it exists because the download is the one long step that can be
    // done before committing an evening.
    await downloadMissingModels(options.codictatePath, options.models);
    console.log(
      "\n--download-models: every weight is on disk and nothing was measured. Models are " +
        "kept; nothing is ever offloaded.",
    );
    return;
  }

  if (!existsSync(datasetsDir)) {
    throw new Error(`Codictate benchmark data missing: ${datasetsDir}`);
  }
  const manifests = new Map<DatasetId, ManifestEntry[]>();
  for (const dataset of options.datasets) {
    manifests.set(dataset, buildManifest(datasetsDir, dataset));
  }

  const { manifest, created } = loadOrCreateBatchManifest(options, manifests, createdAt);
  if (!created) {
    console.log(
      `Reusing the batch manifest written at ${manifest.createdAt}. Its Run Plans decide the ` +
        `range, not today's cursor.`,
    );
    console.log("");
  }

  const records = collectRecords(options);
  const outcomes = manifest.stages
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((stage) => stageDecision(options, stage, records));

  printPlan(options, manifest, outcomes);

  const stagingDir = join(batchDir(options), "staging");
  if (options.dryRun) {
    console.log("");
    console.log(
      "--dry-run: no adapter was invoked, no clip was transcribed, Wispr Flow was not touched. " +
        "The batch manifest and its Run Plans are the only things written, because they are what " +
        "makes the plan above reproducible.",
    );
    return;
  }

  // Every weight, fetched **before the first clip**, in one place, once. `bench:stt`
  // downloads lazily at the start of each stage, which is right for a single-model run
  // and wrong for an 18-model matrix: the night would die on stage sixteen because a
  // mirror was down, hours after the operator went to bed. Nothing is offloaded, ever.
  if (outcomes.some((outcome) => outcome.decision !== "skip-completed")) {
    console.log("\n--- Speech Model weights ---");
    await downloadMissingModels(options.codictatePath, modelsNeededBy(outcomes));
  }

  for (const outcome of outcomes) {
    const { stage, decision } = outcome;
    if (decision === "skip-completed") {
      console.log(`\n[${stage.stageId}] complete, skipped.`);
      saveStageState(options, { ...outcome.state, status: "completed" });
      continue;
    }
    // **Both** harnesses resume by run id. The earlier shape resumed only Wispr Flow
    // and re-issued a Codictate stage's fresh command on the assumption that `--to` is
    // a target depth and therefore idempotent. That is false against Codictate as
    // shipped: a same-`--name` re-run refuses and exits 1 (SPEC addendum §U), so a
    // Codictate stage that crashed at clip 200 wedged the batch - resume decision,
    // fresh command, refusal, stop-on-first-failure, for ever, on every invocation.
    const recordedRunId =
      outcome.state.runId ?? runIdForStage(stage, records, options.batchId);
    if (decision === "resume" && !recordedRunId) {
      throw new Error(
        `[${stage.stageId}] has measurements on disk but no run id recorded for it, so it ` +
          `cannot be resumed by name - and this orchestrator never searches for the latest ` +
          `unfinished run, because that search resumes the wrong one silently.\n\n` +
          `Resume it by hand, then re-run this batch:\n  $ ${manualResumeLine(
            options, stage, "<runId>",
          )}\n\nThe run id is the run directory's name under ${stageResultsRoot(options, stage)}.`,
      );
    }
    const runId = decision === "resume" ? recordedRunId : undefined;
    const command = stageCommand(options, stage, runId);
    console.log(`\n[${stage.stageId}] ${decision}`);
    console.log(`  $ ${shellQuote(command)}`);
    saveStageState(options, {
      ...outcome.state,
      status: "running",
      startedAt: new Date().toISOString(),
      attempts: outcome.state.attempts + 1,
    });

    const child = Bun.spawn(command, {
      cwd: stageCwd(options, stage),
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      const failedRecords = collectRecords(options);
      const failedRunId =
        runIdForStage(stage, failedRecords, options.batchId) ?? recordedRunId;
      saveStageState(options, {
        ...outcome.state,
        ...(failedRunId ? { runId: failedRunId } : {}),
        status: "failed",
        attempts: outcome.state.attempts + 1,
        lastError: `exit code ${exitCode}`,
      });
      writeStaging(options, manifest, outcomes, checks, stagingDir);
      // Stop on the first failure. The stages share a clip set on purpose, so a partial
      // matrix is a comparison with a hole in it.
      //
      // The recovery command is printed for **both** harnesses. A failure message that
      // does not name the way out is the difference between a batch an operator can
      // pick up in the morning and one they have to reverse-engineer.
      throw new Error(
        `[${stage.stageId}] exited ${exitCode}. Stopping: the later stages measure the same ` +
          `clips as this one, so continuing would build a comparison with a hole in it.\n\n` +
          `Fix the cause and re-run the identical batch command - completed stages are skipped ` +
          `and nothing is re-transcribed. If this stage needs resuming by hand first:\n` +
          `  $ ${manualResumeLine(options, stage, failedRunId ?? "<runId>")}\n` +
          (failedRunId
            ? ""
            : `\nThe run id is the run directory's name under ${stageResultsRoot(options, stage)}.\n`),
      );
    }

    const after = collectRecords(options);
    const refreshed = stageDecision(options, stage, after);
    assertStageCompletedAfterExit(stage.stageId, refreshed.decision);
    saveStageState(options, {
      ...refreshed.state,
      // Recorded from the records the stage just wrote rather than parsed out of its
      // stdout: the run id is the one thing a later invocation cannot re-derive, and a
      // log line is not a place to keep it.
      ...(runIdForStage(stage, after, options.batchId)
        ? { runId: runIdForStage(stage, after, options.batchId)! }
        : {}),
      status: refreshed.decision === "skip-completed" ? "completed" : "running",
      completedAt: new Date().toISOString(),
      attempts: outcome.state.attempts + 1,
    });
  }

  writeStaging(options, manifest, outcomes, checks, stagingDir);
  console.log(`\nReadiness report: ${join(stagingDir, "readiness.md")}`);
  console.log("Nothing was published or deployed. Models were left on disk.");
}

function writeStaging(
  options: PublicationOptions,
  manifest: BatchManifest,
  outcomes: readonly StageOutcome[],
  checks: readonly Check[],
  stagingDir: string,
): void {
  mkdirSync(stagingDir, { recursive: true });
  const records = collectRecords(options);
  const refreshed = outcomes.map((outcome) => stageDecision(options, outcome.stage, records));
  writeJsonAtomic(join(stagingDir, "readiness.json"), {
    batchId: manifest.batchId,
    mode: manifest.mode,
    generatedAt: new Date().toISOString(),
    published: false,
    deployed: false,
    instrumentationNote: manifest.instrumentationNote,
    stages: refreshed.map((outcome) => ({
      stageId: outcome.stage.stageId,
      harness: outcome.stage.harness,
      model: outcome.stage.model,
      status: outcome.state.status,
      progress: outcome.state.progress,
    })),
    preflight: checks,
  });
  Bun.write(join(stagingDir, "readiness.md"), readinessReport(options, manifest, refreshed, checks));
}

// -- small parsers --

function csv(value: string, flag: string): string[] {
  const values = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`${flag} cannot be empty`);
  return values;
}

function parseDatasets(value: string): DatasetId[] {
  const values = csv(value, "--datasets");
  for (const dataset of values) {
    if (!(DATASET_IDS as readonly string[]).includes(dataset)) {
      throw new Error(`Unknown dataset "${dataset}". Expected: ${DATASET_IDS.join(", ")}`);
    }
  }
  return values as DatasetId[];
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${flag} must be a non-negative integer index into the consumable range (0 is the first ` +
        `clip after the ${WARMUP_COUNT} reserved warmups)`,
    );
  }
  return parsed;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
