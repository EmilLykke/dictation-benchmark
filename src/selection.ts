import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  /** Shape tag, so a later change to these semantics is detectable rather than silent. */
  selectionVersion: 1;
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
  datasets: Record<string, { manifestFingerprint: string; endIndex: number }>;
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
  startIndex: number;
  /** Half-open planned end, already clamped to `consumableCount`. */
  endIndex: number;
  requestedEndIndex: number;
  truncated: boolean;
  /** Replayed unscored at the start of the dataset. Always the same three clips. */
  warmups: ManifestEntry[];
  /** The consumable slice `[startIndex, endIndex)`. Empty means "nothing to do". */
  clips: ManifestEntry[];
}

export function planDataset(
  dataset: string,
  entries: readonly ManifestEntry[],
  cursor: number,
  request: DepthRequest,
): DatasetPlan {
  const consumable = consumableEntries(entries);
  const consumableCount = consumable.length;
  const start = Math.min(cursor, consumableCount);
  const requestedEndIndex = request.kind === "delta" ? start + request.samples : request.to;
  const endIndex = Math.max(start, Math.min(requestedEndIndex, consumableCount));
  return {
    dataset,
    manifestFingerprint: manifestFingerprint(entries),
    manifestEntryCount: entries.length,
    consumableCount,
    cursor,
    startIndex: start,
    endIndex,
    requestedEndIndex,
    truncated: requestedEndIndex > consumableCount,
    warmups: warmupEntries(entries),
    clips: consumable.slice(start, endIndex),
  };
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
    startIndex: selection.startIndex,
    endIndex: selection.plannedEndIndex,
    requestedEndIndex: selection.requestedEndIndex,
    truncated: selection.truncated,
    warmups: warmupEntries(entries),
    clips: consumable.slice(selection.startIndex, selection.plannedEndIndex),
  };
}

export function selectionFor(plan: DatasetPlan, measured: number): DatasetSelection {
  return {
    selectionVersion: 1,
    warmupCount: WARMUP_COUNT,
    manifestFingerprint: plan.manifestFingerprint,
    manifestEntryCount: plan.manifestEntryCount,
    consumableCount: plan.consumableCount,
    startIndex: plan.startIndex,
    endIndex: plan.startIndex + measured,
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
 */
export function formatPlanLine(plan: DatasetPlan): string {
  const remaining = plan.consumableCount - plan.endIndex;
  if (plan.clips.length === 0) {
    const reason = plan.startIndex >= plan.consumableCount
      ? `all ${plan.consumableCount} consumable clips already measured`
      : `already at or past depth ${plan.requestedEndIndex} of ${plan.consumableCount} consumable`;
    return `${plan.dataset}: cursor ${plan.cursor} -> ${plan.endIndex} (nothing to run: ${reason})`;
  }
  const line =
    `${plan.dataset}: cursor ${plan.cursor} -> ${plan.endIndex}` +
    ` (clips ${plan.startIndex + 1}-${plan.endIndex} of ${plan.consumableCount} consumable,` +
    ` ${remaining} remaining after)`;
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
    datasets[dataset] = {
      manifestFingerprint: selection.manifestFingerprint,
      endIndex: selection.endIndex,
    };
  }
  return {
    runId: typeof run.runId === "string" ? run.runId : runId,
    productId,
    productVersion: typeof run.product?.version === "string" ? run.product.version : null,
    datasets,
  };
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  record: RunSelectionRecord;
}

interface CacheFile {
  version: 1;
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
  const next: CacheFile = { version: 1, runs: {} };
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
 * Cursor per dataset: the deepest point any matching-fingerprint run reached.
 *
 * Throws `ManifestFingerprintMismatch` rather than returning a cursor whenever a run
 * that measured something recorded a different fingerprint for a dataset being asked
 * about.
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
      cursors.set(dataset, Math.max(cursors.get(dataset) ?? 0, recorded.endIndex));
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
  if (!existsSync(path)) return { version: 1, runs: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (parsed?.version !== 1 || typeof parsed.runs !== "object") return { version: 1, runs: {} };
    return parsed;
  } catch {
    return { version: 1, runs: {} };
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
