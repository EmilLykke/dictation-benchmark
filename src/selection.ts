import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fingerprintV2Record,
  isRunStatus,
  type FingerprintV2,
  type IncompleteRunRef,
  type RunStatus,
} from "./contract";
import type { ManifestEntry } from "./types";

/**
 * Entries at the head of every dataset's ordered manifest that are reserved as a
 * permanent warmup pool.
 *
 * They are replayed at the start of every session so the product is warm before
 * anything is scored, and for exactly that reason they are never scored and never
 * consumed: a session that took its warmups off the front of the range it was about
 * to measure would burn three fresh clips per dataset per session, forever, and the
 * accumulated total would drift below the number of clips actually paid for.
 * The consumable range therefore begins at manifest index `WARMUP_COUNT`.
 */
export const WARMUP_COUNT = 3;

/** Cache file name, written inside the results root. Derived data; safe to delete. */
export const CURSOR_CACHE_FILE = ".selection-cache.json";

/**
 * The range of consumable entries one run measured for one dataset, as recorded in
 * that run's `results.json` under `results.<dataset>.selection`.
 *
 * Sample selection is a deterministic ordered list — `buildManifest` ends in
 * `seededShuffle(entries, 42)` — so "which clips has this repo already measured" is
 * fully described by an integer offset into that list. No per-clip ledger is needed,
 * and none is kept.
 */
export interface DatasetSelection {
  /**
   * Shape tag, so a later change to these semantics is detectable rather than silent.
   *
   * `1` is the shape written before the cursor was made contiguous: `endIndex` alone,
   * with no way to tell a run that measured `[0, 400)` from one that measured
   * `[600, 900)` and left a hole. `2` adds `contiguousEndIndex`,
   * `maxMeasuredEndIndex`, `priorCursor` and `clipFingerprintV2`. Records of both
   * shapes are read; only `2` is written.
   */
  selectionVersion: 1 | 2;
  /** Reserved warmup entries at the head of the manifest. Outside every range below. */
  warmupCount: number;
  /** See `manifestFingerprint`. Guards every offset in this record. */
  manifestFingerprint: string;
  /** Ordered manifest length the fingerprint was taken over, warmups included. */
  manifestEntryCount: number;
  /** `manifestEntryCount - warmupCount`: the entries a run is allowed to consume. */
  consumableCount: number;
  /** First consumable index this run measures, inclusive. */
  startIndex: number;
  /**
   * Half-open end of what has actually been measured, updated after every clip.
   * This — not `plannedEndIndex` — is what the cursor is derived from, so a run
   * that died halfway advances the cursor by exactly the clips it finished.
   */
  endIndex: number;
  /**
   * The **production cursor** this run leaves behind: the contiguous measured prefix.
   *
   * This — not `endIndex` — is what `deriveCursors` maxes over, and the difference is
   * defect 12. `endIndex` is where this run's own range reached; a run started past
   * the cursor with `--from` reaches a high `endIndex` over clips that are only
   * measured from `startIndex` on, and `max(cursor, endIndex)` then declared the hole
   * measured. A depth is only publishable if every clip below it has been
   * transcribed, so a gap holds the cursor at where the contiguity actually stops.
   *
   * Absent on `selectionVersion: 1` records, where `endIndex` is read instead. That
   * fallback is exact for the committed archive rather than approximate: every run in
   * `results/` recorded `startIndex: 0`, so its `endIndex` *is* its contiguous prefix.
   *
   * Mirrors `src/contract/selection.ts::contiguousCursor`.
   */
  contiguousEndIndex: number;
  /**
   * One past the deepest clip measured, **gaps included. Not a cursor.**
   *
   * Kept beside `contiguousEndIndex` and labelled non-contiguous because the two
   * disagreeing is the useful signal: `397` against `900` says three hundred clips are
   * missing from the middle of a range that claims to reach 900. It is a diagnostic for
   * the preview and for coverage, and it never feeds a cursor, an aggregate or a
   * published depth.
   *
   * Mirrors `src/contract/selection.ts::maxMeasuredEnd`.
   */
  maxMeasuredEndIndex: number;
  /**
   * The cursor this run started from, recorded so a reader can tell a continuation
   * from a rewind from a gap without re-deriving anything.
   */
  priorCursor: number;
  /**
   * The v2 fingerprint of this run's **selected scored clipIds**, warmups excluded.
   *
   * The cross-repository equality token: two runs measured the same clips in the same
   * order exactly when these two values match (SPEC §2). Stored in the shape both
   * repositories write — the field name `clipFingerprintV2` *and* the embedded
   * `version` — because a bare 16-hex string travels detached from its record and
   * carries no clue which algorithm produced it (addendum §A).
   *
   * **Never comparable with `manifestFingerprint` above.** That one is
   * `sha256:<hex>` over the dataset's whole ordered pool *including* the reserved
   * warmups, and it answers "do my stored integer offsets still index into this list".
   * This one is over the clips one run measured, warmups excluded (addendum §F), and
   * answers "did these two runs measure the same clips". Opposite conventions on
   * warmups, different questions, different field names, never migrated into one
   * another.
   */
  clipFingerprintV2: FingerprintV2;
  /** Half-open end this run intends to reach. `--resume` continues towards it. */
  plannedEndIndex: number;
  /** Depth the operator asked for, before exhaustion truncated it. */
  requestedEndIndex: number;
  /** True when `requestedEndIndex` ran past `consumableCount`. */
  truncated: boolean;
}

/** What one run contributes to the cursor scan. */
export interface RunSelectionRecord {
  runId: string;
  productId: string;
  /**
   * Recorded so an aggregate spanning several sessions can state its version mix.
   * The cursor itself is per product, not per product-version: Flow auto-updates, so
   * a per-version cursor would reset every few days and never accumulate.
   */
  productVersion: string | null;
  /**
   * Whether the process that wrote this record finished the plan it was given.
   *
   * **Only `completed` records feed the production cursor**, aggregation, coverage,
   * staging or publication (defect 3). An `incomplete` record is a resume source and
   * an overlap check input, and nothing else: an unfinished run has not been checked
   * against its plan, and counting its depth means the *next* run starts past clips
   * the interrupted one never reached — then resuming the interrupted one overlaps the
   * new one and two processes write two measurements of the same clip.
   *
   * Explicit rather than inferred from "does it have as many samples as it planned",
   * because the two answers differ in the case that matters: a run killed after its
   * last clip but before its footer has every sample and is still not a completed run.
   * A record with no status at all is read as `incomplete`, deliberately — see
   * `readRunSelections`.
   */
  status: RunStatus;
  datasets: Record<
    string,
    {
      manifestFingerprint: string;
      /** This run's own range end. Not the cursor. */
      endIndex: number;
      /** The contiguous prefix, which is the cursor. `endIndex` for a v1 record. */
      contiguousEndIndex: number;
      /** Gap-inclusive end. Diagnostic only. */
      maxMeasuredEndIndex: number;
      /** First consumable index this run measured, when it recorded one. */
      startIndex: number;
      /** Half-open end the run intended to reach, when it recorded one. */
      plannedEndIndex: number;
    }
  >;
}

export interface FingerprintConflict {
  dataset: string;
  runId: string;
  recordedFingerprint: string;
  recordedEndIndex: number;
  currentFingerprint: string;
  currentEntryCount: number;
}

/**
 * Raised instead of starting a run whose stored offsets no longer describe the
 * clips they were recorded against.
 *
 * This is the single most dangerous failure mode in the accumulating-cursor design:
 * an offset is only meaningful relative to one exact ordering, so if the ordering
 * changed — clips added or removed, corpus regenerated, shuffle seed changed — then
 * "397 already measured" points at a different 397 clips than it used to. Falling
 * back to zero would quietly re-measure some clips and never measure others, and the
 * resulting aggregate would be wrong in a way nothing downstream could detect.
 */
export class ManifestFingerprintMismatch extends Error {
  constructor(readonly conflicts: FingerprintConflict[], datasetsDir: string) {
    super(mismatchMessage(conflicts, datasetsDir));
    this.name = "ManifestFingerprintMismatch";
  }
}

function mismatchMessage(conflicts: FingerprintConflict[], datasetsDir: string): string {
  const lines = [
    "Manifest fingerprint mismatch: the deterministic clip order changed since an",
    "earlier run recorded its position in it.",
    "",
  ];
  for (const conflict of conflicts) {
    lines.push(`  ${conflict.dataset}`);
    lines.push(`    now:      ${conflict.currentFingerprint} (${conflict.currentEntryCount} entries)`);
    lines.push(
      `    recorded: ${conflict.recordedFingerprint} by ${conflict.runId} (endIndex ${conflict.recordedEndIndex})`,
    );
  }
  lines.push(
    "",
    "Every stored cursor is an integer offset into that order, so it now names",
    "different clips than it did when it was written. Continuing would re-measure",
    "some clips and never measure others, and no downstream reader could tell.",
    "",
    "Options:",
    `  1. Restore the dataset files that produced the recorded order. Check ${datasetsDir}`,
    "     for added, removed or renamed clips, and check that the shuffle seed is",
    "     still 42 in src/manifest.ts.",
    "  2. Start a fresh accumulation: move the runs named above out of results/ into",
    "     an archive directory. Cursors are derived from results/, so the new order",
    "     then starts from 0 and the archived runs stay readable.",
    "  3. Leave the affected datasets out of this run with --datasets, and carry on",
    "     accumulating the datasets whose order is unchanged.",
    "",
    "Refusing to run.",
  );
  return lines.join("\n");
}

/**
 * Stable hash of a dataset's ordered clip IDs.
 *
 * Only the IDs and their order matter, because that is exactly what an offset is an
 * offset into. Audio bytes, transcripts and durations are deliberately excluded: a
 * re-encoded WAV does not invalidate a cursor, whereas an inserted clip does.
 */
export function manifestFingerprint(entries: readonly { id: string }[]): string {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.id);
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** The reserved warmup pool: replayed every session, never scored, never consumed. */
export function warmupEntries(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return entries.slice(0, WARMUP_COUNT);
}

/** The entries a run may consume, index 0 of which is manifest index `WARMUP_COUNT`. */
export function consumableEntries(entries: readonly ManifestEntry[]): ManifestEntry[] {
  return entries.slice(WARMUP_COUNT);
}

/** How the operator expressed the depth they want. Exactly one field is set. */
export type DepthRequest =
  /** `--samples N`: run N more from wherever the cursor is. Destructive by default. */
  | { kind: "delta"; samples: number }
  /**
   * `--to N`: have N measured in total when this finishes. A no-op when the cursor
   * is already at or past N, which is what makes re-running an interrupted overnight
   * command safe.
   */
  | { kind: "target"; to: number };

export interface DatasetPlan {
  dataset: string;
  manifestFingerprint: string;
  manifestEntryCount: number;
  consumableCount: number;
  /** Consumable entries already measured for this product before this run. */
  cursor: number;
  /**
   * The `--from N` override, or `null` when the cursor picked the start.
   *
   * Kept on the plan so the preview can say a start index was *imposed* rather than
   * derived. Every other flag can only ever push the range forward; this is the one
   * that can point it at clips already paid for, and a reader of the preview has to
   * be able to see which of the two happened.
   */
  fromIndex: number | null;
  startIndex: number;
  /** Half-open planned end, already clamped to `consumableCount`. */
  endIndex: number;
  requestedEndIndex: number;
  truncated: boolean;
  /**
   * True when `--from` starts inside the measured prefix, so this run re-measures
   * clips this product has already been measured on. The only genuinely destructive
   * path in the harness, and the reason `formatPlanLine` has a branch for it.
   */
  rewind: boolean;
  /**
   * True when `--from` starts *past* the cursor, leaving `[cursor, startIndex)`
   * unmeasured while the depth this run records jumps over it. Not a rewind, but the
   * mirror-image hazard: a claimed depth over clips nobody transcribed.
   */
  gap: boolean;
  /**
   * The cursor this run leaves behind: the **contiguous** measured prefix.
   *
   * `max(cursor, endIndex)` for a run that starts at or below the cursor, and simply
   * `cursor` for a gap — because a gap leaves `[cursor, startIndex)` untranscribed, and
   * a prefix with a hole in it is not a prefix. That distinction is defect 12: with
   * `max` alone, `--from 600` on a 397 cursor recorded a cursor of 900 and the next run
   * started at 900, so clips 398-600 were skipped for ever and no published number
   * showed it.
   *
   * A rewind can still only raise the cursor or leave it alone, which is what the
   * preview promises in the same line that announces the rewind.
   */
  cursorAfter: number;
  /**
   * One past the deepest clip this run will have measured, gaps included. **Not a
   * cursor.** See `DatasetSelection.maxMeasuredEndIndex`.
   */
  maxMeasuredEndAfter: number;
  /** Replayed unscored at the start of the dataset. Always the same three clips. */
  warmups: ManifestEntry[];
  /** The consumable slice `[startIndex, endIndex)`. Empty means "nothing to do". */
  clips: ManifestEntry[];
}

/**
 * Turns a cursor, a depth and an optional explicit start into the range to run.
 *
 * `fromIndex` is `--from N`: the start index this run uses *instead of* the cursor,
 * for this run only. Nothing is written back and no cursor is edited — the override
 * exists so the same clips can be measured twice, which is the only way to tell a
 * real change apart from a change of sample.
 */
export function planDataset(
  dataset: string,
  entries: readonly ManifestEntry[],
  cursor: number,
  request: DepthRequest,
  fromIndex?: number,
): DatasetPlan {
  const consumable = consumableEntries(entries);
  const consumableCount = consumable.length;
  const start = Math.min(fromIndex ?? cursor, consumableCount);
  const requestedEndIndex = request.kind === "delta" ? start + request.samples : request.to;
  const endIndex = Math.max(start, Math.min(requestedEndIndex, consumableCount));
  return {
    dataset,
    manifestFingerprint: manifestFingerprint(entries),
    manifestEntryCount: entries.length,
    consumableCount,
    cursor,
    fromIndex: fromIndex ?? null,
    startIndex: start,
    endIndex,
    requestedEndIndex,
    truncated: requestedEndIndex > consumableCount,
    rewind: fromIndex !== undefined && start < cursor,
    gap: fromIndex !== undefined && start > cursor,
    // Contiguity, not depth. A run that starts past the cursor cannot extend the
    // prefix, however deep it reaches. See `DatasetPlan.cursorAfter`.
    cursorAfter: start > cursor ? cursor : Math.max(cursor, endIndex),
    maxMeasuredEndAfter: Math.max(cursor, endIndex),
    warmups: warmupEntries(entries),
    clips: consumable.slice(start, endIndex),
  };
}

/**
 * Rejects a `--from N` no selected dataset can honour, naming the dataset and its
 * consumable count.
 *
 * Checked rather than clamped. Every other offset in this module is derived from a
 * recorded range and is therefore inside the pool by construction; `--from` is typed
 * by a human, so `--from 5000` on a 902-clip pool would otherwise silently measure
 * nothing and record a depth of 902. Returns the message rather than throwing so the
 * bound can be unit-tested without a results tree.
 */
export function fromIndexError(
  fromIndex: number,
  consumableCounts: ReadonlyMap<string, number>,
): string | null {
  if (!Number.isInteger(fromIndex) || fromIndex < 0) {
    return `--from must be a non-negative integer index into the consumable range, got ${fromIndex}.`;
  }
  for (const [dataset, consumableCount] of consumableCounts) {
    if (consumableCount === 0) {
      return (
        `--from ${fromIndex} is out of range for ${dataset}: it has 0 consumable clips, ` +
        `so there is nothing for --from to point at.`
      );
    }
    if (fromIndex >= consumableCount) {
      return (
        `--from ${fromIndex} is out of range for ${dataset}: it has ${consumableCount} ` +
        `consumable clips, so the valid --from indices are 0-${consumableCount - 1}.`
      );
    }
  }
  return null;
}

/** Rebuilds a plan from a range a run already recorded, for `--resume`. */
export function resumePlan(
  dataset: string,
  entries: readonly ManifestEntry[],
  selection: DatasetSelection,
): DatasetPlan {
  const consumable = consumableEntries(entries);
  return {
    dataset,
    manifestFingerprint: manifestFingerprint(entries),
    manifestEntryCount: entries.length,
    consumableCount: consumable.length,
    cursor: selection.startIndex,
    // A resume replays a range that is already on disk, so there is nothing to
    // override and nothing to warn about: `--from` is refused alongside `--resume`.
    fromIndex: null,
    startIndex: selection.startIndex,
    endIndex: selection.plannedEndIndex,
    requestedEndIndex: selection.requestedEndIndex,
    truncated: selection.truncated,
    rewind: false,
    gap: false,
    // The run recorded its own contiguous prefix; a resume inherits it rather than
    // re-deriving one from `startIndex`, which for a gap run is past the prefix.
    cursorAfter: selection.contiguousEndIndex ?? selection.startIndex,
    maxMeasuredEndAfter: Math.max(
      selection.maxMeasuredEndIndex ?? 0,
      selection.plannedEndIndex,
    ),
    warmups: warmupEntries(entries),
    clips: consumable.slice(selection.startIndex, selection.plannedEndIndex),
  };
}

/**
 * The record one dataset of one run writes, given how many of its planned clips are
 * captured.
 *
 * `measured` is the contiguous prefix of *this run's own range* that is captured
 * (`measuredPrefix` in `src/runner.ts`), so `endIndex` is the depth this run reached.
 * The two v2 numbers beside it are what a reader may and may not treat as a depth:
 * `contiguousEndIndex` is the cursor and never crosses a hole, `maxMeasuredEndIndex`
 * is the gap-inclusive end and is a diagnostic.
 */
export function selectionFor(plan: DatasetPlan, measured: number): DatasetSelection {
  const endIndex = plan.startIndex + measured;
  return {
    selectionVersion: 2,
    warmupCount: WARMUP_COUNT,
    manifestFingerprint: plan.manifestFingerprint,
    manifestEntryCount: plan.manifestEntryCount,
    consumableCount: plan.consumableCount,
    startIndex: plan.startIndex,
    endIndex,
    // Only a run that starts at or below the cursor can extend the prefix.
    contiguousEndIndex: plan.startIndex > plan.cursor ? plan.cursor : Math.max(plan.cursor, endIndex),
    maxMeasuredEndIndex: Math.max(plan.cursor, endIndex),
    priorCursor: plan.cursor,
    // The selected scored clips, warmups excluded (SPEC addendum §F).
    clipFingerprintV2: fingerprintV2Record(plan.clips.map((entry) => entry.clipId)),
    plannedEndIndex: plan.endIndex,
    requestedEndIndex: plan.requestedEndIndex,
    truncated: plan.truncated,
  };
}

/**
 * The plan preview line.
 *
 * Printed for every dataset before any clip runs, because `--samples` is a delta and
 * therefore destructive by default: running the same command twice consumes twice.
 * An operator has to be able to see which clips a command is about to spend.
 *
 * A `--from` rewind gets its own shape rather than the same shape with different
 * numbers. It is the one path that spends clips already paid for, so it says so in
 * words — the arrow runs backwards, the flag is named next to the cursor it overrode,
 * and the count of clips being measured a second time is spelled out. A reader
 * skimming for the usual `cursor A -> B` cannot mistake it for a forward run.
 */
export function formatPlanLine(plan: DatasetPlan): string {
  const remaining = plan.consumableCount - plan.endIndex;
  if (plan.clips.length === 0) {
    if (plan.fromIndex !== null) {
      return (
        `${plan.dataset}: nothing to run: --from ${plan.fromIndex} with depth ` +
        `${plan.requestedEndIndex} selects no clips (cursor stays ${plan.cursor})`
      );
    }
    const reason = plan.startIndex >= plan.consumableCount
      ? `all ${plan.consumableCount} consumable clips already measured`
      : `already at or past depth ${plan.requestedEndIndex} of ${plan.consumableCount} consumable`;
    return `${plan.dataset}: cursor ${plan.cursor} -> ${plan.endIndex} (nothing to run: ${reason})`;
  }
  const clips = `clips ${plan.startIndex + 1}-${plan.endIndex} of ${plan.consumableCount} consumable`;
  let line: string;
  if (plan.rewind) {
    const again = Math.min(plan.endIndex, plan.cursor) - plan.startIndex;
    line =
      `${plan.dataset}: REWIND cursor ${plan.cursor} -> --from ${plan.fromIndex}` +
      ` (re-measuring ${clips}, ${again} of them already measured;` +
      ` cursor ends at ${plan.cursorAfter}, never lower than ${plan.cursor})`;
  } else if (plan.gap) {
    line =
      `${plan.dataset}: GAP --from ${plan.fromIndex} starts past cursor ${plan.cursor}` +
      ` (${clips}, leaving clips ${plan.cursor + 1}-${plan.startIndex} unmeasured;` +
      ` cursor ends at ${plan.cursorAfter}, unmoved because the prefix stops at the hole;` +
      ` maxMeasuredEnd ${plan.maxMeasuredEndAfter}, not contiguous and not a depth)`;
  } else {
    line =
      `${plan.dataset}: cursor ${plan.cursor} -> ${plan.endIndex}` +
      ` (${clips}, ${remaining} remaining after)`;
  }
  if (!plan.truncated) return line;
  const short = plan.requestedEndIndex - plan.consumableCount;
  return `${line} [EXHAUSTED: depth ${plan.requestedEndIndex} requested, ${short} beyond the corpus; running the ${plan.clips.length} that remain]`;
}

/**
 * Pulls the per-dataset selection records out of one run's `results.json`.
 *
 * Returns `null` for anything that is not a readable run record, and simply omits
 * datasets with no selection record — runs made before this scheme existed
 * contribute nothing to a cursor unless they were backfilled.
 *
 * The run's status is mapped rather than trusted verbatim. The runner writes the v1
 * vocabulary (`"running"` while it works, `"completed"` at the end); the contract's is
 * `"incomplete" | "completed"`, so `"running"` maps to `"incomplete"` and both
 * spellings of `"completed"` are accepted. **Anything else, including a missing field,
 * reads as `incomplete`** — the conservative direction. A record whose status cannot
 * be established has not been checked against its plan, and the cost of the two
 * mistakes is not symmetric: excluding a finished run costs a re-measurement of clips
 * that are still in the corpus, while including an unfinished one advances a published
 * depth over clips nobody transcribed.
 */
export function readRunSelections(runDir: string, runId: string): RunSelectionRecord | null {
  const path = join(runDir, "results.json");
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const run = parsed as {
    runId?: unknown;
    status?: unknown;
    product?: { id?: unknown; version?: unknown };
    results?: Record<string, { selection?: Partial<DatasetSelection> }>;
  };
  const productId = typeof run.product?.id === "string" ? run.product.id : null;
  if (!productId) return null;
  const datasets: RunSelectionRecord["datasets"] = {};
  for (const [dataset, result] of Object.entries(run.results ?? {})) {
    const selection = result?.selection;
    if (!selection) continue;
    if (typeof selection.manifestFingerprint !== "string") continue;
    if (typeof selection.endIndex !== "number") continue;
    const startIndex = typeof selection.startIndex === "number" ? selection.startIndex : 0;
    datasets[dataset] = {
      manifestFingerprint: selection.manifestFingerprint,
      endIndex: selection.endIndex,
      // A `selectionVersion: 1` record has no contiguous end. Its `endIndex` is read
      // instead, which is exact rather than approximate for the committed archive:
      // every run in `results/` recorded `startIndex: 0`, so its range *is* a prefix.
      contiguousEndIndex:
        typeof selection.contiguousEndIndex === "number"
          ? selection.contiguousEndIndex
          : selection.endIndex,
      maxMeasuredEndIndex:
        typeof selection.maxMeasuredEndIndex === "number"
          ? selection.maxMeasuredEndIndex
          : selection.endIndex,
      startIndex,
      plannedEndIndex:
        typeof selection.plannedEndIndex === "number"
          ? selection.plannedEndIndex
          : selection.endIndex,
    };
  }
  return {
    runId: typeof run.runId === "string" ? run.runId : runId,
    productId,
    productVersion: typeof run.product?.version === "string" ? run.product.version : null,
    status: runStatusOf(run.status),
    datasets,
  };
}

/** The v1 runner's `"running" | "completed"` in the contract's vocabulary. */
function runStatusOf(status: unknown): RunStatus {
  if (status === "running") return "incomplete";
  if (isRunStatus(status)) return status;
  return "incomplete";
}

/**
 * The unfinished runs that touched one dataset, as clip lists an overlap check can use.
 *
 * Index ranges are deliberately converted to clipIds here rather than compared as
 * ranges: a range is only meaningful against one ordering of one dataset, and the clip
 * set is the fact (`src/contract/selection.ts::overlaps`). The range converted is
 * `[startIndex, plannedEndIndex)` — what the run *intends* to measure, not what it has
 * measured so far — because a run that is still going will reach the rest of it, and
 * blocking only on the finished part would let a second run start on the clips the
 * first is about to reach.
 */
export function incompleteRunsFor(
  records: readonly RunSelectionRecord[],
  dataset: string,
  entries: readonly ManifestEntry[],
  options: { excludeRunId?: string } = {},
): IncompleteRunRef[] {
  const consumable = consumableEntries(entries);
  const refs: IncompleteRunRef[] = [];
  for (const record of records) {
    if (record.status === "completed") continue;
    if (record.runId === options.excludeRunId) continue;
    const recorded = record.datasets[dataset];
    if (!recorded) continue;
    const orderedClipIds = consumable
      .slice(recorded.startIndex, Math.max(recorded.plannedEndIndex, recorded.endIndex))
      .map((entry) => entry.clipId);
    if (orderedClipIds.length === 0) continue;
    refs.push({ runId: record.runId, orderedClipIds });
  }
  return refs;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  record: RunSelectionRecord;
}

/**
 * Version `2` because `RunSelectionRecord` gained `status` and the contiguous/max ends.
 *
 * Bumped rather than tolerated: a version-1 entry has no `status`, and a cache hit on
 * one would have handed `deriveCursors` a record it then read as incomplete — a cursor
 * that depended on whether the cache happened to be warm. A stale cache is discarded
 * and re-derived from the runs, which is the source of truth anyway.
 */
interface CacheFile {
  version: 2;
  runs: Record<string, CacheEntry>;
}

/**
 * Every run record on disk for one product, newest scan cached beside them.
 *
 * The results tree is the source of truth — a hand-maintained cursor file can drift
 * from what was actually measured, and would then be silently wrong. The cache only
 * ever short-circuits re-parsing a `results.json` whose size and mtime are unchanged,
 * so deleting it costs time and nothing else.
 */
export function scanRunRecords(
  resultsRoot: string,
  options: { productId: string },
): RunSelectionRecord[] {
  const cache = readCache(join(resultsRoot, CURSOR_CACHE_FILE));
  const next: CacheFile = { version: 2, runs: {} };
  const records: RunSelectionRecord[] = [];
  let changed = false;

  for (const runId of listRunDirs(resultsRoot)) {
    const runDir = join(resultsRoot, runId);
    const path = join(runDir, "results.json");
    let stats: { mtimeMs: number; size: number };
    try {
      const raw = statSync(path);
      stats = { mtimeMs: raw.mtimeMs, size: raw.size };
    } catch {
      continue;
    }
    const cached = cache.runs[runId];
    let record: RunSelectionRecord | null;
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      record = cached.record;
    } else {
      record = readRunSelections(runDir, runId);
      changed = true;
    }
    if (!record) continue;
    next.runs[runId] = { ...stats, record };
    if (record.productId !== options.productId) continue;
    records.push(record);
  }

  if (Object.keys(next.runs).length !== Object.keys(cache.runs).length) changed = true;
  if (changed) writeCache(join(resultsRoot, CURSOR_CACHE_FILE), next);
  return records;
}

/**
 * Cursor per dataset: the deepest **contiguous** prefix any matching-fingerprint
 * **completed** run reached.
 *
 * Two rules that used to be missing, and the failure each one prevents:
 *
 * - **Completed runs only** (defect 3). An interrupted run's recorded depth used to
 *   feed this max, so starting a second run after a partial one skipped ahead — and
 *   then resuming the first overlapped the second, leaving two measurements of the
 *   same clips and the tie to a timestamp.
 * - **The contiguous prefix, not the range end** (defect 12). `--from` past the cursor
 *   produced a high `endIndex` over a range with a hole below it, and maxing on
 *   `endIndex` declared the hole measured.
 *
 * Throws `ManifestFingerprintMismatch` rather than returning a cursor whenever a run
 * that measured something recorded a different fingerprint for a dataset being asked
 * about. Incomplete runs are checked for that too: their offsets are about to be used
 * by a resume, so a mismatch there is just as dangerous.
 */
export function deriveCursors(
  records: readonly RunSelectionRecord[],
  fingerprints: ReadonlyMap<string, { fingerprint: string; entryCount: number }>,
  datasetsDir: string,
): Map<string, number> {
  const conflicts: FingerprintConflict[] = [];
  const cursors = new Map<string, number>();
  for (const dataset of fingerprints.keys()) cursors.set(dataset, 0);

  for (const record of records) {
    for (const [dataset, recorded] of Object.entries(record.datasets)) {
      const current = fingerprints.get(dataset);
      if (!current) continue;
      if (recorded.manifestFingerprint !== current.fingerprint) {
        if (recorded.endIndex > 0) {
          conflicts.push({
            dataset,
            runId: record.runId,
            recordedFingerprint: recorded.manifestFingerprint,
            recordedEndIndex: recorded.endIndex,
            currentFingerprint: current.fingerprint,
            currentEntryCount: current.entryCount,
          });
        }
        continue;
      }
      if (record.status !== "completed") continue;
      cursors.set(dataset, Math.max(cursors.get(dataset) ?? 0, recorded.contiguousEndIndex));
    }
  }

  if (conflicts.length > 0) throw new ManifestFingerprintMismatch(conflicts, datasetsDir);
  return cursors;
}

function listRunDirs(resultsRoot: string): string[] {
  if (!existsSync(resultsRoot)) return [];
  return readdirSync(resultsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function readCache(path: string): CacheFile {
  const empty: CacheFile = { version: 2, runs: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed?.version !== 2 || typeof parsed.runs !== "object") return empty;
    return parsed;
  } catch {
    return empty;
  }
}

function writeCache(path: string, cache: CacheFile): void {
  try {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`);
    renameSync(temporary, path);
  } catch {
    // A cache is an optimisation. A read-only results tree must not fail a run.
  }
}
