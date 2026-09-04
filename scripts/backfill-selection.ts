/**
 * Writes a `selection` record into runs made before consumable ranges were recorded.
 *
 * Those runs took `--samples N` to mean "the first N entries of the ordered
 * manifest", and used the first three of that slice as warmups. Under the current
 * scheme the first three entries are a reserved warmup pool that is never consumed,
 * so such a run consumed consumable entries `[0, N - 3)`.
 *
 * The mapping is verified against the clips actually stored in the run before anything
 * is written: sample `i` must be manifest entry `i`, the three warmups must be exactly
 * the manifest head, and scored sample `j` must be consumable entry `j`. A run that
 * does not satisfy that is reported and skipped rather than guessed at.
 *
 * The comparison is on **`clipId`** — the corpus-relative audio path — and not on the
 * legacy `id`, which for FLEURS is the sentence id and repeats. Every committed record
 * carries `audioPath` in exactly that spelling (`portableAudioPath`), so the identity
 * is available for the whole archive. On the colliding `id` the positional check would
 * have accepted a run whose clips were permuted within a sentence group, and then
 * written a range that named different clips than the ones stored under it. Records so
 * old that they carry no path at all fall back to `id` and say so in the report.
 *
 * Usage:
 *   bun run scripts/backfill-selection.ts [--codictate <path>] [--write] <runDir>...
 *
 * Without `--write` it only reports what it would do.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildManifest } from "../src/manifest";
import {
  consumableEntries,
  manifestFingerprint,
  warmupEntries,
  WARMUP_COUNT,
  type DatasetSelection,
} from "../src/selection";
import { clipIdFromRelativeAudioPath, fingerprintV2Record } from "../src/contract";
import { datasetsRoot } from "../src/portable-paths";
import { DATASET_IDS, type DatasetId, type ManifestEntry } from "../src/types";

interface StoredRun {
  runId: string;
  config: { samples?: number; datasets: DatasetId[] };
  results: Record<
    string,
    { samples: StoredSample[]; selection?: DatasetSelection }
  >;
}

interface StoredSample {
  id: string;
  warmup: boolean;
  /** Present on every committed record. Already the canonical clipId string. */
  audioPath?: string;
  /** Present on records written after clip identity landed. */
  clipId?: string;
}

/**
 * How one stored sample is compared against the manifest.
 *
 * `clipId` when the record has one or can be read as one, otherwise the legacy `id`.
 * Returned as a tagged pair so the report can say which basis it used rather than
 * leaving a reader to assume the strong one.
 */
function storedIdentity(sample: StoredSample): { basis: "clipId" | "id"; value: string } {
  if (sample.clipId) return { basis: "clipId", value: sample.clipId };
  if (sample.audioPath) {
    return { basis: "clipId", value: clipIdFromRelativeAudioPath(sample.audioPath) };
  }
  return { basis: "id", value: sample.id };
}

interface Verdict {
  dataset: string;
  ok: boolean;
  detail: string;
  selection?: DatasetSelection;
}

function verify(
  dataset: string,
  entries: ManifestEntry[],
  stored: StoredSample[],
): Verdict {
  const identities = stored.map(storedIdentity);
  const basis: "clipId" | "id" = identities.every((identity) => identity.basis === "clipId")
    ? "clipId"
    : "id";
  const keyOf = (entry: ManifestEntry) => (basis === "clipId" ? entry.clipId : entry.id);
  const storedKey = (index: number) => identities[index].value;

  const manifestIds = entries.map(keyOf);
  const warmupIds = warmupEntries(entries).map(keyOf);
  const consumableIds = consumableEntries(entries).map(keyOf);
  const consumableClipIds = consumableEntries(entries).map((entry) => entry.clipId);

  const prefixMismatch = stored.findIndex((_sample, index) => manifestIds[index] !== storedKey(index));
  if (prefixMismatch !== -1) {
    return {
      dataset,
      ok: false,
      detail: `sample ${prefixMismatch} is ${storedKey(prefixMismatch)}, manifest entry ${prefixMismatch} is ${manifestIds[prefixMismatch]} (compared by ${basis})`,
    };
  }

  const storedWarmups = stored
    .map((sample, index) => ({ sample, key: storedKey(index) }))
    .filter((entry) => entry.sample.warmup)
    .map((entry) => entry.key);
  if (storedWarmups.join("|") !== warmupIds.join("|")) {
    return {
      dataset,
      ok: false,
      detail: `warmups are ${storedWarmups.join(", ")}, manifest head is ${warmupIds.join(", ")}`,
    };
  }

  const scored = stored
    .map((sample, index) => ({ sample, key: storedKey(index) }))
    .filter((entry) => !entry.sample.warmup)
    .map((entry) => entry.key);
  const offset = scored.findIndex((id, index) => consumableIds[index] !== id);
  if (offset !== -1) {
    return {
      dataset,
      ok: false,
      detail: `scored sample ${offset} is ${scored[offset]}, consumable entry ${offset} is ${consumableIds[offset]}`,
    };
  }

  return {
    dataset,
    ok: true,
    detail:
      `${stored.length} stored samples = manifest[0..${stored.length - 1}]; ` +
      `${storedWarmups.length} warmups = manifest head; ` +
      `${scored.length} scored = consumable[0..${scored.length - 1}] of ${consumableIds.length}; ` +
      `compared by ${basis}`,
    selection: {
      selectionVersion: 2,
      warmupCount: WARMUP_COUNT,
      manifestFingerprint: manifestFingerprint(entries),
      manifestEntryCount: entries.length,
      consumableCount: consumableIds.length,
      startIndex: 0,
      endIndex: scored.length,
      // A backfilled run measured `[0, scored)`, so its range *is* its contiguous
      // prefix and there is no gap to distinguish. Recorded explicitly rather than
      // left to `readRunSelections`'s fallback, so the archive stops depending on it.
      contiguousEndIndex: scored.length,
      maxMeasuredEndIndex: scored.length,
      priorCursor: 0,
      clipFingerprintV2: fingerprintV2Record(consumableClipIds.slice(0, scored.length)),
      plannedEndIndex: scored.length,
      requestedEndIndex: scored.length,
      truncated: false,
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  let codictatePath = resolve(import.meta.dir, "../../codictate");
  let write = false;
  const runDirs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--write") write = true;
    else if (flag === "--codictate") codictatePath = resolve(args[++index] ?? "");
    else if (flag.startsWith("--")) throw new Error(`Unknown flag: ${flag}`);
    else runDirs.push(resolve(flag));
  }
  if (runDirs.length === 0) throw new Error("Pass at least one run directory");

  const datasetsDir = datasetsRoot(codictatePath);
  if (!existsSync(datasetsDir)) throw new Error(`Codictate benchmark data missing: ${datasetsDir}`);
  const manifests = new Map<DatasetId, ManifestEntry[]>();
  for (const dataset of DATASET_IDS) manifests.set(dataset, buildManifest(datasetsDir, dataset));

  let failures = 0;
  for (const runDir of runDirs) {
    const path = join(runDir, "results.json");
    const run = JSON.parse(readFileSync(path, "utf8")) as StoredRun;
    console.log(`\n${run.runId}  (--samples ${run.config.samples ?? "?"} under the old scheme)`);
    const verdicts: Verdict[] = [];
    for (const [dataset, result] of Object.entries(run.results)) {
      const entries = manifests.get(dataset as DatasetId);
      if (!entries) {
        console.log(`  ${dataset}: unknown dataset, skipped`);
        continue;
      }
      const verdict = verify(dataset, entries, result.samples);
      verdicts.push(verdict);
      console.log(`  ${dataset}: ${verdict.ok ? "CONFIRMED" : "REFUSED"} - ${verdict.detail}`);
      if (verdict.ok && verdict.selection) {
        const { startIndex, endIndex, consumableCount } = verdict.selection;
        console.log(
          `    -> selection startIndex ${startIndex}, endIndex ${endIndex} ` +
            `(consumable ${startIndex}..${endIndex - 1} of ${consumableCount}), ` +
            `fingerprint ${verdict.selection.manifestFingerprint}`,
        );
      }
    }
    if (verdicts.some((verdict) => !verdict.ok)) {
      failures += 1;
      console.log("  nothing written for this run: at least one dataset failed verification");
      continue;
    }
    if (!write) {
      console.log("  dry run; pass --write to record these ranges");
      continue;
    }
    for (const verdict of verdicts) run.results[verdict.dataset].selection = verdict.selection;
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`);
    renameSync(temporary, path);
    console.log(`  written: ${path}`);
  }
  if (failures > 0) process.exit(1);
}

main();
