/**
 * Reading and writing benchmark-v2 run records: the per-clip measurements v1 had no
 * way to store, and the production cursor derived from them.
 *
 * A v1 `results.json` stays exactly what it was — an immutable legacy snapshot, still
 * read by `src/selection.ts` and `src/codictate-compat.ts`. A v2 record is a **second,
 * additive** file per dataset under `<runDir>/v2/<dataset>.json`, in the shape
 * `src/contract/schema.ts::RunRecordV2` pins, so a pooling reader loads a record from
 * either repository without a per-repository adapter. The two are never merged and a
 * v1 aggregate leaf is never re-read as v2 per-clip measurements: there is no inverse.
 *
 * Three rules this module exists to enforce, each of them a defect if it is not:
 *
 * - **Only `completed` records feed the production cursor** (defect 3). An `incomplete`
 *   record is a resume source and an overlap-check input and nothing else.
 * - **The cursor is the contiguous measured prefix** (defect 12), never the deepest
 *   clip reached. `maxMeasuredEnd` is exposed separately and labelled.
 * - **`results/smoke/` is excluded** from every scan. Smoke output is disposable,
 *   git-ignored, and five clips deep; letting it into the cursor would advance a
 *   published depth by a rehearsal.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  assertRunPlanOnDisk,
  assertRunRecordAgreesWithPlan,
  compatibilityKey,
  contiguousCursor,
  isMeasuringHarness,
  fingerprintV2Matches,
  isRunRecordV2,
  maxMeasuredEnd,
  normalizeRunRecordV2,
  runPlanRef,
  SCHEMA_VERSION,
  SCHEMA_VERSION_KEY,
  type RunPlan,
  type RunRecordV2,
  type RunStatus,
  type SampleMeasurementV2,
} from "./contract";

/**
 * The marker a file must contain before it is worth parsing as a v2 record.
 *
 * `"schemaVersion": 2`, or the accepted `SCHEMA_VERSION` alias, with any whitespace.
 * Deliberately not just the key: a v1 `results.json` carries the same key with the
 * value `1`.
 */
const V2_RECORD_MARKER = new RegExp(
  `"(?:${SCHEMA_VERSION_KEY}|SCHEMA_VERSION)"\\s*:\\s*${SCHEMA_VERSION}\\b`,
);

/** Directory inside a run directory that holds the v2 records, one per dataset. */
export const V2_DIR = "v2";

/** Directory inside a run directory that holds the immutable Run Plans. */
export const PLAN_DIR = "plans";

/**
 * The results subdirectory smoke runs write to, and the one every scan skips.
 *
 * A single name rather than a pattern, and checked as the first path segment, so a
 * production run can never be excluded by accident: `results/smoke/...` is skipped and
 * `results/20260904_..._smoke-check/` is not.
 */
export const SMOKE_DIR = "smoke";

/** Whether a path segment inside the results root is smoke output. */
export function isSmokePath(relativePath: string): boolean {
  const [first] = relativePath.split(/[\\/]/);
  return first === SMOKE_DIR;
}

export interface BuildRunRecordInput {
  plan: RunPlan;
  status: RunStatus;
  /** ISO 8601, set before the first clip. */
  startedAt: string;
  /** ISO 8601. `null` while the record is incomplete. */
  completedAt: string | null;
  samples: readonly SampleMeasurementV2[];
  description?: string;
}

/**
 * One dataset of one Benchmark Run, in the shape both repositories write.
 *
 * The plan's `fingerprintV2` is copied to the top level as well as being carried
 * inside `plan`. That is the contract's shape (`RunRecordV2`) and the duplication is
 * for the reader's convenience — compatibility is checked on every pooled record and a
 * reader should not have to reach through a nested plan reference to do it.
 * `assertRunRecordAgreesWithPlan` is the guard that keeps the copy honest.
 */
export function buildRunRecordV2(input: BuildRunRecordInput): RunRecordV2 {
  const { plan } = input;
  // `RunPlan.harness` is a plain string; `RunRecordV2.harness` is a `MeasuringHarness`,
  // because it is a pooling key. Checked rather than cast: an unrecognised harness would
  // create a series that pools with nothing and reads as an unmeasured product.
  if (!isMeasuringHarness(plan.harness)) {
    throw new Error(
      `Run Plan ${plan.runId} names harness "${plan.harness}", which is not a measuring ` +
        `harness. A record's harness is part of its compatibility key, so an unrecognised ` +
        `one would pool with nothing and look like a product nobody measured.`,
    );
  }
  const record: RunRecordV2 = {
    schemaVersion: SCHEMA_VERSION,
    runId: plan.runId,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    harness: plan.harness,
    model: plan.model,
    datasetId: plan.datasetId,
    plan: runPlanRef(plan),
    fingerprintV2: plan.fingerprintV2,
    samples: [...input.samples],
    ...(plan.batchId === undefined ? {} : { batchId: plan.batchId }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
  // Checked at the point of construction rather than trusted. The top-level
  // `fingerprintV2` and `runId` are copies of the plan reference's, for the reader's
  // convenience, and this is the price of the duplication: a mismatch means the record
  // was assembled from two different plans, and pooling it would attribute one plan's
  // clips to another plan's selection.
  assertRunRecordAgreesWithPlan(record);
  return record;
}

/**
 * Write, flush to the platter, rename over the target.
 *
 * The temporary file is a sibling because `rename` is only atomic within one
 * filesystem. The `fsync` is what makes the rename mean anything: without it a power
 * loss can leave the directory entry pointing at a file whose contents never reached
 * the disk, and surviving that is the entire purpose of a checkpoint. Best-effort,
 * because a filesystem that refuses `fsync` must not fail a run that is otherwise fine.
 *
 * Called after **every scored clip**. Never batched: a 50-clip batch costs up to fifty
 * clips of real-time playback on a crash, and afterwards those clips are
 * indistinguishable from clips that were never planned.
 */
export function writeJsonAtomic(target: string, value: unknown): void {
  const temporary = `${target}.tmp`;
  const handle = openSync(temporary, "w");
  try {
    writeSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    try {
      fsyncSync(handle);
    } catch {
      // Some filesystems and sandboxes refuse fsync. The write still precedes the
      // rename; only the power-loss guarantee is lost.
    }
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, target);
}

/** `<runDir>/v2/<dataset>.json`. One file per dataset, checkpointed independently. */
export function v2RecordPath(runDir: string, dataset: string): string {
  return join(runDir, V2_DIR, `${dataset}.json`);
}

/** `<runDir>/plans/<dataset>.json`. Written once, before the first clip, never edited. */
export function planPath(runDir: string, dataset: string): string {
  return join(runDir, PLAN_DIR, `${dataset}.json`);
}

/** Checkpoint one dataset's v2 record. Creates `<runDir>/v2/` on first use. */
export function saveRunRecordV2(runDir: string, dataset: string, record: RunRecordV2): void {
  mkdirSync(join(runDir, V2_DIR), { recursive: true });
  writeJsonAtomic(v2RecordPath(runDir, dataset), record);
}

/**
 * Write a Run Plan **once**, and refuse to overwrite one that already exists.
 *
 * The immutability is enforced here rather than trusted, because every resume story
 * rests on it: a resumed process re-reads this file instead of re-deriving a range, so
 * a plan that could be rewritten would let the second invocation of `--samples 400`
 * mean "another 400 clips" while the record still claimed the first 400's fingerprint.
 * An identical re-write is a no-op rather than an error, so a re-run of the same
 * orchestrator command is safe; a *different* plan under the same name is refused with
 * both fingerprints named.
 */
export function saveRunPlanOnce(runDir: string, dataset: string, plan: RunPlan): RunPlan {
  mkdirSync(join(runDir, PLAN_DIR), { recursive: true });
  const path = planPath(runDir, dataset);
  const existing = readRunPlan(path);
  if (existing) {
    if (existing.fingerprintV2.value === plan.fingerprintV2.value) return existing;
    throw new Error(
      `Run Plan ${path} already exists with fingerprint ${existing.fingerprintV2.value}, and this ` +
        `invocation built ${plan.fingerprintV2.value} for the same stage. A Run Plan is immutable: ` +
        `the numbers already recorded against it belong to its clips, not to these. Resume the ` +
        `existing plan by run id, or start a new run.`,
    );
  }
  writeJsonAtomic(path, plan);
  return plan;
}

/**
 * A Run Plan off disk, or `null` when there is no file and no readable JSON there.
 *
 * A file that *is* there and is malformed **throws**, and the two cases are kept apart
 * on purpose. "No plan yet" is the ordinary state of a stage that has not started, and a
 * scan has to keep going past it. "A plan that has been edited, truncated or built
 * against a different corpus" is the resume path being handed something it is about to
 * trust completely - the process would skip every clip the plan says is done and measure
 * the rest - so it is refused with every complaint named
 * (`src/contract/selection.ts::assertRunPlanOnDisk`).
 *
 * The fingerprint is re-derived from the plan's own clipIds rather than believed. A plan
 * whose recorded fingerprint disagrees with its list is the one file in this design that
 * nothing downstream could detect: every record copies the fingerprint from it.
 */
export function readRunPlan(path: string, runId?: string): RunPlan | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  assertRunPlanOnDisk(parsed, runId);
  if (!fingerprintV2Matches(parsed.fingerprintV2, parsed.orderedClipIds)) {
    throw new Error(
      `Run Plan ${path} carries fingerprint ${JSON.stringify(parsed.fingerprintV2)}, which does ` +
        `not match its own ${parsed.orderedClipIds.length} clipIds. The file has been edited; ` +
        `nothing may be resumed from it.`,
    );
  }
  return parsed;
}

/**
 * A v2 run record off disk, normalised and guarded.
 *
 * `normalizeRunRecordV2` runs **before** the guard, per SPEC addendum §Q: a record
 * written with the constant's name (`SCHEMA_VERSION`) as its key is legible to a human
 * and invisible to `isRunRecordV2`, which is the dangerous combination — the guard
 * rejects it, nothing logs, and the run vanishes from pooling while still sitting on
 * disk. The alias is rewritten and dropped, so it cannot round-trip back out.
 */
export function readRunRecordV2(path: string): RunRecordV2 | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    const text = readFileSync(path, "utf8");
    // Cheap reject before the parse. The v1 archive holds 400-sample `results.json`
    // files that are megabytes each and are read by the v1 path; there is no reason to
    // build an object graph for one just to fail the guard on its first field.
    //
    // Matched on the **version** and not only on the key, because a v1 record carries
    // `"schemaVersion": 1` - so a key-only check passed every one of those megabyte
    // files through and the optimisation never fired for the files it names. Whitespace
    // is tolerated between the key and the value, since a hand-formatted record is
    // exactly the kind that gets read once.
    if (!V2_RECORD_MARKER.test(text)) return null;
    parsed = normalizeRunRecordV2(JSON.parse(text));
  } catch {
    return null;
  }
  return isRunRecordV2(parsed) ? parsed : null;
}

export interface ScannedV2Record {
  /** Path relative to the results root, for messages. */
  relativePath: string;
  record: RunRecordV2;
}

/**
 * How deep a scan walks, counted in directory levels below the root.
 *
 * `<root>/<runId>/v2/<dataset>.json` needs 2 - the walk enters `<runId>` at depth 1 and
 * `v2` at depth 2, and reads files there. Codictate nests one level deeper
 * (`<root>/<runDir>/_v2/<stage>.run.json` under a batch directory), so 4 leaves room
 * for a layout this repository does not own without walking an entire home directory
 * if someone points `--out` somewhere surprising.
 */
const MAX_SCAN_DEPTH = 4;

/**
 * Every v2 record under a results root, smoke output excluded.
 *
 * A bounded recursive walk rather than the single hard-coded
 * `<resultsRoot>/<runId>/v2/*.json` shape, because the orchestrator has to read the
 * **Codictate** results tree as well as this one and the two layouts are not the same
 * — Codictate owns where it puts its v2 records, and a shape assumption here would
 * make a Codictate stage look permanently unmeasured. A file counts if it guards as a
 * `RunRecordV2`, whatever it is called.
 *
 * `results/smoke/` is skipped at the top level. Smoke output is disposable, five clips
 * deep and git-ignored; letting it into a cursor would advance a published depth by a
 * rehearsal. `includeSmoke` is for the smoke chain itself, which reads its own tree.
 *
 * The tree is the source of truth. A hand-maintained index can drift from what was
 * actually measured and would then be silently wrong, which is the same reason
 * `src/selection.ts` derives its cursor from the runs rather than from a ledger.
 */
export function scanRunRecordsV2(
  resultsRoot: string,
  options: { includeSmoke?: boolean } = {},
): ScannedV2Record[] {
  if (!existsSync(resultsRoot)) return [];
  const found: ScannedV2Record[] = [];

  const walk = (dir: string, relative: string, depth: number): void => {
    if (depth > MAX_SCAN_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relativePath = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (!options.includeSmoke && isSmokePath(relativePath)) continue;
        walk(join(dir, entry.name), relativePath, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const record = readRunRecordV2(join(dir, entry.name));
      if (!record) continue;
      found.push({ relativePath, record });
    }
  };

  walk(resultsRoot, "", 0);
  return found;
}

export interface V2Cursor {
  /**
   * The production cursor: how far the contiguous measured prefix of this plan
   * reaches, in plan-relative positions. The only number that may be published as a
   * depth.
   */
  cursor: number;
  /**
   * One past the deepest measured clip, gaps included. **Not contiguous and not a
   * depth.** Kept beside the cursor because the two disagreeing is the useful signal.
   */
  maxMeasuredEnd: number;
  /** Records that were skipped, and why. */
  skipped: readonly { relativePath: string; reason: PlanMatchSkip }[];
}

/** Why a record on disk said nothing about a plan. */
export type PlanMatchSkip = "incomplete" | "other-series" | "other-clips";

/**
 * The series a Run Plan belongs to: `(schemaVersion, harness, model, datasetId)`.
 *
 * A plan does not carry `schemaVersion` - it is not a record - so it is supplied from
 * the constant every record this repository writes carries.
 */
export function planCompatibilityKey(plan: RunPlan): string {
  return compatibilityKey({
    schemaVersion: SCHEMA_VERSION,
    harness: plan.harness,
    model: plan.model,
    datasetId: plan.datasetId,
  });
}

/**
 * Whether a record measured **this plan's series over this plan's clips**.
 *
 * Both halves, and the second half alone was a critical defect. The v2 fingerprint is
 * `sha256` over the ordered clipId list and **nothing else** (SPEC addendum §F), so it
 * is *identical across harnesses and models by design* - that is the entire point of it:
 * it is what proves Wispr Flow and `large-v3-q5_0` measured the same clips. Matching a
 * record to a plan on it alone therefore matched every product to every other product's
 * plan. A completed Wispr Flow stage marked both Codictate stages complete, the
 * orchestrator skipped them without ever invoking Codictate, and the readiness report
 * said all three had run - so the one thing this orchestrator exists to guarantee
 * silently did not happen, and the artifact claimed it did.
 *
 * `compatibilityKey` is what separates the series, and the contract exports it for
 * exactly this. The fingerprint still has to match too: a record from the same series
 * over a *different* range says nothing about this plan's ordering.
 */
export function recordMatchesPlan(plan: RunPlan, record: RunRecordV2): boolean {
  return (
    compatibilityKey(record) === planCompatibilityKey(plan) &&
    record.fingerprintV2.value === plan.fingerprintV2.value
  );
}

/**
 * How deep a plan has actually been measured, across every completed record on disk.
 *
 * Only `completed` records contribute (defect 3), and only records of the **same series
 * over the same clips** (`recordMatchesPlan`). A record from another product is skipped
 * as `other-series` and a record from another range as `other-clips`, and the two
 * reasons are separate because they mean different things to an operator: the first is
 * normal - the other product's records are right there in the same tree - and the second
 * says a plan was rebuilt.
 */
export function v2CursorFor(
  plan: RunPlan,
  records: readonly ScannedV2Record[],
): V2Cursor {
  const measured = new Set<string>();
  const skipped: { relativePath: string; reason: PlanMatchSkip }[] = [];
  const key = planCompatibilityKey(plan);

  for (const { relativePath, record } of records) {
    if (compatibilityKey(record) !== key) {
      skipped.push({ relativePath, reason: "other-series" });
      continue;
    }
    if (record.fingerprintV2.value !== plan.fingerprintV2.value) {
      skipped.push({ relativePath, reason: "other-clips" });
      continue;
    }
    if (record.status !== "completed") {
      skipped.push({ relativePath, reason: "incomplete" });
      continue;
    }
    for (const sample of record.samples) {
      if (sample.isWarmup) continue;
      measured.add(sample.clipId);
    }
  }

  return {
    cursor: contiguousCursor(plan.orderedClipIds, measured),
    maxMeasuredEnd: maxMeasuredEnd(plan.orderedClipIds, measured),
    skipped,
  };
}

/**
 * Whether this plan's own series has measured every clip the plan names.
 *
 * Takes the cursor rather than recomputing it per record: the previous shape called
 * `v2CursorFor` inside a `some` predicate, which walked every record once per record.
 * The completeness question is about the pooled cursor anyway, so one pass answers it.
 */
export function isStageComplete(
  plan: RunPlan,
  records: readonly ScannedV2Record[],
  cursor: V2Cursor = v2CursorFor(plan, records),
): boolean {
  return cursor.cursor === plan.orderedClipIds.length;
}

/** `mtime` of a path, or `0`. Used only for ordering messages, never for a metric. */
export function modifiedAtMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
