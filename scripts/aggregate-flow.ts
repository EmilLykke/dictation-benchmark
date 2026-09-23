/**
 * Pool every completed run of one Wispr Flow build into `results/stt.json`.
 *
 * A single run is one session, and a full corpus on Flow does not fit in one: 19.8 hours
 * of real-time audio. The 1.6.897 measurement is two runs, clips 1-950 and 951 to the end
 * of English. Without this file the website picks the deeper of the two and compares the
 * 951-end half against a Codictate figure over all 2,617 clips.
 *
 * Deliberately one build. Flow auto-updates and its Danish has moved from 5.45% to 10.08%
 * to 6.40% WER across builds on the same clips, so pooling across versions would average
 * a broken build into the headline. Defaults to the newest build in `results/`; pass
 * `--version 1.6.897` to pin it.
 *
 * Clips are keyed by `clipId`. A clip measured twice on the same build keeps the later
 * run's measurement. Warmups are dropped: they are never scored.
 *
 *   bun run scripts/aggregate-flow.ts [--version X.Y.Z] [--dry-run]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCodictateResults, type CompatibleRun } from "../src/codictate-compat";
import { DATASET_IDS, type DatasetId } from "../src/types";

const resultsRoot = resolve(import.meta.dir, "../results");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const versionFlag = args.indexOf("--version");
const pinned = versionFlag >= 0 ? args[versionFlag + 1] : undefined;

type AnyRun = CompatibleRun & { status: string; runId: string };

const runs: AnyRun[] = readdirSync(resultsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d{8}_\d{6}_/.test(entry.name))
  .map((entry) => join(resultsRoot, entry.name, "results.json"))
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, "utf8")) as AnyRun)
  .filter((run) => run.status === "completed" && run.product?.version)
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

const compareVersions = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
};
const version =
  pinned ?? runs.map((run) => run.product.version!).sort(compareVersions).at(-1);
if (!version) throw new Error("No completed Flow run in results/");

const chosen = runs.filter((run) => run.product.version === version);
if (chosen.length === 0) throw new Error(`No completed run on Flow ${version}`);
console.log(`Flow ${version}: pooling ${chosen.length} run(s): ${chosen.map((r) => r.runId).join(", ")}`);

const notes = new Set(chosen.map((run) => run.config.configurationNote));
if (notes.size > 1) {
  throw new Error(
    `Runs on ${version} disagree on configuration and cannot be pooled:\n  ${[...notes].join("\n  ")}`,
  );
}

const newest = chosen.at(-1)!;
const merged: CompatibleRun = {
  createdAt: chosen[0].createdAt,
  completedAt: newest.completedAt,
  product: newest.product,
  hardware: newest.hardware,
  config: { ...newest.config, datasets: [], samples: undefined, to: undefined },
  results: {},
};

for (const dataset of DATASET_IDS as readonly DatasetId[]) {
  const byClip = new Map<string, NonNullable<CompatibleRun["results"][DatasetId]>["samples"][number]>();
  let consumable: number | undefined;
  let selection: NonNullable<CompatibleRun["results"][DatasetId]>["selection"];
  for (const run of chosen) {
    const result = run.results[dataset];
    if (!result) continue;
    consumable = result.selection?.consumableCount ?? consumable;
    selection = result.selection ?? selection;
    for (const sample of result.samples) {
      if (sample.warmup) continue;
      byClip.set(sample.clipId ?? sample.audioPath, sample);
    }
  }
  if (byClip.size === 0 || !selection) continue;

  const samples = [...byClip.values()];
  merged.config.datasets.push(dataset);
  merged.results[dataset] = {
    samples,
    // One contiguous range over the pooled clips, so the dataset reads as complete.
    selection: { ...selection, startIndex: 0, endIndex: samples.length, plannedEndIndex: samples.length },
  };
  const coverage = consumable ? `${samples.length} of ${consumable}` : `${samples.length}`;
  console.log(`  ${dataset}: ${coverage} clips${consumable && samples.length < consumable ? "  (NOT the whole corpus)" : ""}`);
}

const out = buildCodictateResults(merged);
out.description = out.description.replace(
  "external-product benchmark",
  `external-product benchmark, pooled over ${chosen.length} run(s)`,
);
if (dryRun) {
  console.log("Dry run: nothing written.");
} else {
  const target = join(resultsRoot, "stt.json");
  writeFileSync(target, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${target}`);
}
