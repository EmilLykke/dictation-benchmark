import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  consumableEntries,
  CURSOR_CACHE_FILE,
  deriveCursors,
  formatPlanLine,
  ManifestFingerprintMismatch,
  manifestFingerprint,
  planDataset,
  resumePlan,
  scanRunRecords,
  selectionFor,
  warmupEntries,
  WARMUP_COUNT,
  type DatasetSelection,
} from "../src/selection";
import type { ManifestEntry } from "../src/types";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(count: number, prefix = "clip"): ManifestEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index}`,
    audioPath: `/tmp/${prefix}-${index}.wav`,
    transcript: "reference",
    language: "en",
    audioDurationSec: 2,
  }));
}

/**
 * A results tree of the shape the runner writes, so the cursor can be derived from
 * the same thing production reads: the runs on disk.
 */
function resultsTree(
  runs: Array<{
    runId: string;
    productId?: string;
    productVersion?: string | null;
    datasets: Record<string, Partial<DatasetSelection> & { manifestFingerprint: string; endIndex: number }>;
  }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "selection-"));
  temporaryRoots.push(root);
  for (const run of runs) {
    const runDir = join(root, run.runId);
    mkdirSync(runDir, { recursive: true });
    const results: Record<string, unknown> = {};
    for (const [dataset, selection] of Object.entries(run.datasets)) {
      results[dataset] = { samples: [], selection };
    }
    writeFileSync(
      join(runDir, "results.json"),
      JSON.stringify({
        runId: run.runId,
        product: {
          id: run.productId ?? "wispr-flow",
          label: "Wispr Flow",
          version: run.productVersion ?? "1.6.765",
        },
        results,
      }),
    );
  }
  return root;
}

function fingerprintMap(
  entries: Record<string, ManifestEntry[]>,
): Map<string, { fingerprint: string; entryCount: number }> {
  return new Map(
    Object.entries(entries).map(([dataset, list]) => [
      dataset,
      { fingerprint: manifestFingerprint(list), entryCount: list.length },
    ]),
  );
}

function cursorsFrom(root: string, entries: Record<string, ManifestEntry[]>): Map<string, number> {
  const records = scanRunRecords(root, { productId: "wispr-flow" });
  return deriveCursors(records, fingerprintMap(entries), "/tmp/datasets");
}

describe("manifest fingerprint", () => {
  test("is the ordered clip IDs and nothing else", () => {
    const entries = manifest(5);
    const reencoded = entries.map((entry) => ({
      ...entry,
      audioPath: "/elsewhere.wav",
      audioDurationSec: 99,
      transcript: "rewritten",
    }));

    // A re-encoded WAV or a re-normalised transcript must not invalidate a cursor;
    // only a change to which clips are in the list, or their order, may.
    expect(manifestFingerprint(reencoded)).toBe(manifestFingerprint(entries));
  });

  test("changes when an entry is inserted, removed or reordered", () => {
    const entries = manifest(5);
    const base = manifestFingerprint(entries);

    expect(manifestFingerprint([...entries, ...manifest(1, "extra")])).not.toBe(base);
    expect(manifestFingerprint(entries.slice(1))).not.toBe(base);
    expect(manifestFingerprint([entries[1], entries[0], ...entries.slice(2)])).not.toBe(base);
  });
});

describe("warmup reservation", () => {
  test("the reserved pool is the manifest head and is outside every consumable range", () => {
    const entries = manifest(10);

    expect(warmupEntries(entries).map((entry) => entry.id)).toEqual(["clip-0", "clip-1", "clip-2"]);
    expect(consumableEntries(entries)[0].id).toBe(`clip-${WARMUP_COUNT}`);
    expect(consumableEntries(entries)).toHaveLength(10 - WARMUP_COUNT);
  });

  test("warmups are never consumed, however many sessions run", () => {
    const entries = manifest(20);
    let cursor = 0;
    const scored: string[] = [];
    for (let session = 0; session < 4; session++) {
      const plan = planDataset("test-clean", entries, cursor, { kind: "delta", samples: 4 });
      // Every session replays the same three clips, and none of them is ever in the
      // scored range. Taking warmups off the head of the range instead would burn
      // three fresh clips per dataset per session, forever.
      expect(plan.warmups.map((entry) => entry.id)).toEqual(["clip-0", "clip-1", "clip-2"]);
      scored.push(...plan.clips.map((entry) => entry.id));
      cursor = plan.endIndex;
    }

    expect(new Set(scored).size).toBe(scored.length);
    expect(scored).not.toContain("clip-0");
    expect(scored).not.toContain("clip-1");
    expect(scored).not.toContain("clip-2");
    expect(scored[0]).toBe("clip-3");
    expect(cursor).toBe(16);
  });
});

describe("--samples is a delta", () => {
  test("runs the next N and advances the cursor by N", () => {
    const entries = manifest(50);
    const first = planDataset("hu_hu", entries, 0, { kind: "delta", samples: 10 });

    expect(first.startIndex).toBe(0);
    expect(first.endIndex).toBe(10);
    expect(first.clips.map((entry) => entry.id)).toEqual(
      Array.from({ length: 10 }, (_unused, index) => `clip-${index + WARMUP_COUNT}`),
    );

    const second = planDataset("hu_hu", entries, first.endIndex, { kind: "delta", samples: 10 });

    expect(second.startIndex).toBe(10);
    expect(second.endIndex).toBe(20);
    expect(second.clips[0].id).toBe(`clip-${10 + WARMUP_COUNT}`);
  });

  test("the cursor derived from the results tree is what the next delta starts at", () => {
    const entries = manifest(50);
    const first = planDataset("hu_hu", entries, 0, { kind: "delta", samples: 10 });
    const root = resultsTree([
      {
        runId: "20260904_000000_session-1",
        datasets: { hu_hu: selectionFor(first, first.clips.length) },
      },
    ]);

    const cursors = cursorsFrom(root, { hu_hu: entries });

    expect(cursors.get("hu_hu")).toBe(10);
    const next = planDataset("hu_hu", entries, cursors.get("hu_hu")!, { kind: "delta", samples: 10 });
    expect(next.clips[0].id).toBe(`clip-${10 + WARMUP_COUNT}`);
  });
});

describe("--to is a target depth", () => {
  test("runs only the shortfall", () => {
    const entries = manifest(50);
    const plan = planDataset("hu_hu", entries, 30, { kind: "target", to: 40 });

    expect(plan.startIndex).toBe(30);
    expect(plan.endIndex).toBe(40);
    expect(plan.clips).toHaveLength(10);
  });

  test("is idempotent: re-running an interrupted command measures nothing twice", () => {
    const entries = manifest(50);
    const first = planDataset("hu_hu", entries, 0, { kind: "target", to: 20 });
    const root = resultsTree([
      {
        runId: "20260904_000000_overnight",
        datasets: { hu_hu: selectionFor(first, first.clips.length) },
      },
    ]);

    const again = planDataset("hu_hu", entries, cursorsFrom(root, { hu_hu: entries }).get("hu_hu")!, {
      kind: "target",
      to: 20,
    });

    expect(again.clips).toHaveLength(0);
    expect(again.endIndex).toBe(20);
    expect(formatPlanLine(again)).toBe(
      "hu_hu: cursor 20 -> 20 (nothing to run: already at or past depth 20 of 47 consumable)",
    );
  });

  test("a target already passed is still a no-op, not a rewind", () => {
    const entries = manifest(50);
    const plan = planDataset("hu_hu", entries, 30, { kind: "target", to: 20 });

    expect(plan.clips).toHaveLength(0);
    expect(plan.startIndex).toBe(30);
    expect(plan.endIndex).toBe(30);
  });
});

describe("exhaustion", () => {
  test("truncates to what remains instead of throwing", () => {
    const entries = manifest(10);
    const plan = planDataset("hu_hu", entries, 5, { kind: "delta", samples: 400 });

    expect(plan.truncated).toBe(true);
    expect(plan.consumableCount).toBe(7);
    expect(plan.endIndex).toBe(7);
    expect(plan.clips.map((entry) => entry.id)).toEqual(["clip-8", "clip-9"]);
    expect(formatPlanLine(plan)).toContain("EXHAUSTED");
  });

  test("planning every dataset survives one of them being exhausted", () => {
    // buildPlan used to throw when a dataset had fewer clips than requested, which
    // would abort an overnight run that could still have measured the other four.
    const datasets = { small: manifest(6, "s"), large: manifest(500, "l") };
    const plans = Object.entries(datasets).map(([dataset, entries]) =>
      planDataset(dataset, entries, 0, { kind: "delta", samples: 400 }),
    );

    expect(plans).toHaveLength(2);
    expect(plans[0].truncated).toBe(true);
    expect(plans[0].clips).toHaveLength(3);
    expect(plans[1].truncated).toBe(false);
    expect(plans[1].clips).toHaveLength(400);
  });

  test("an exhausted dataset records the true depth and never wraps around", () => {
    const entries = manifest(10);
    const plan = planDataset("hu_hu", entries, 5, { kind: "delta", samples: 400 });
    const selection = selectionFor(plan, plan.clips.length);

    expect(selection.endIndex).toBe(7);
    expect(selection.requestedEndIndex).toBe(405);
    expect(selection.truncated).toBe(true);

    const root = resultsTree([{ runId: "20260904_000000_last", datasets: { hu_hu: selection } }]);
    const after = planDataset("hu_hu", entries, cursorsFrom(root, { hu_hu: entries }).get("hu_hu")!, {
      kind: "delta",
      samples: 400,
    });

    expect(after.clips).toHaveLength(0);
    expect(formatPlanLine(after)).toBe(
      "hu_hu: cursor 7 -> 7 (nothing to run: all 7 consumable clips already measured)",
    );
  });
});

describe("cursor derivation from the results tree", () => {
  test("matches a hand-built fixture: max endIndex per dataset, per product", () => {
    const clean = manifest(100, "clean");
    const hungarian = manifest(60, "hu");
    const root = resultsTree([
      {
        runId: "20260901_000000_first",
        datasets: {
          "test-clean": { manifestFingerprint: manifestFingerprint(clean), endIndex: 20 },
          hu_hu: { manifestFingerprint: manifestFingerprint(hungarian), endIndex: 5 },
        },
      },
      {
        runId: "20260902_000000_second",
        productVersion: "1.7.0",
        datasets: {
          "test-clean": { manifestFingerprint: manifestFingerprint(clean), endIndex: 45 },
        },
      },
      {
        // A different product accumulates separately; it must not move this cursor.
        runId: "20260903_000000_other-product",
        productId: "some-other-product",
        datasets: {
          "test-clean": { manifestFingerprint: manifestFingerprint(clean), endIndex: 900 },
        },
      },
    ]);

    const cursors = cursorsFrom(root, { "test-clean": clean, hu_hu: hungarian });

    expect(cursors.get("test-clean")).toBe(45);
    expect(cursors.get("hu_hu")).toBe(5);
  });

  test("the cursor accumulates across product versions, because Flow auto-updates", () => {
    const entries = manifest(100);
    const root = resultsTree([
      {
        runId: "20260901_000000_a",
        productVersion: "1.6.765",
        datasets: { hu_hu: { manifestFingerprint: manifestFingerprint(entries), endIndex: 397 } },
      },
      {
        runId: "20260902_000000_b",
        productVersion: "1.6.900",
        datasets: { hu_hu: { manifestFingerprint: manifestFingerprint(entries), endIndex: 500 } },
      },
    ]);

    expect(cursorsFrom(root, { hu_hu: entries }).get("hu_hu")).toBe(500);
    // The version mix is still recoverable, which is what lets an aggregate spanning
    // sessions disclose it.
    expect(
      scanRunRecords(root, { productId: "wispr-flow" }).map((record) => record.productVersion).sort(),
    ).toEqual(["1.6.765", "1.6.900"]);
  });

  test("runs with no selection record contribute nothing", () => {
    const entries = manifest(100);
    const root = mkdtempSync(join(tmpdir(), "selection-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "20260901_000000_legacy"));
    writeFileSync(
      join(root, "20260901_000000_legacy", "results.json"),
      JSON.stringify({
        runId: "20260901_000000_legacy",
        product: { id: "wispr-flow", label: "Wispr Flow", version: "1.6.765" },
        config: { samples: 400 },
        results: { hu_hu: { samples: [] } },
      }),
    );

    expect(cursorsFrom(root, { hu_hu: entries }).get("hu_hu")).toBe(0);
  });

  test("caches the scan beside the runs without changing its answer", () => {
    const entries = manifest(100);
    const root = resultsTree([
      {
        runId: "20260901_000000_a",
        datasets: { hu_hu: { manifestFingerprint: manifestFingerprint(entries), endIndex: 397 } },
      },
    ]);

    expect(cursorsFrom(root, { hu_hu: entries }).get("hu_hu")).toBe(397);
    expect(existsSync(join(root, CURSOR_CACHE_FILE))).toBe(true);
    expect(cursorsFrom(root, { hu_hu: entries }).get("hu_hu")).toBe(397);
  });
});

describe("fingerprint mismatch", () => {
  test("refuses to run rather than silently restarting from zero", () => {
    const entries = manifest(100);
    const root = resultsTree([
      {
        runId: "20260902_181511_wispr-flow-all-400",
        datasets: { hu_hu: { manifestFingerprint: "sha256:stale", endIndex: 397 } },
      },
    ]);

    expect(() => cursorsFrom(root, { hu_hu: entries })).toThrow(ManifestFingerprintMismatch);
  });

  test("names the dataset, both fingerprints, the run, and the operator's options", () => {
    const entries = manifest(100);
    const root = resultsTree([
      {
        runId: "20260902_181511_wispr-flow-all-400",
        datasets: { hu_hu: { manifestFingerprint: "sha256:stale", endIndex: 397 } },
      },
    ]);

    let message = "";
    try {
      cursorsFrom(root, { hu_hu: entries });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("hu_hu");
    expect(message).toContain("sha256:stale");
    expect(message).toContain(manifestFingerprint(entries));
    expect(message).toContain("20260902_181511_wispr-flow-all-400");
    expect(message).toContain("endIndex 397");
    expect(message).toContain("Options:");
    expect(message).toContain("Refusing to run.");
  });

  test("a stale record that measured nothing is not a conflict", () => {
    const entries = manifest(100);
    const root = resultsTree([
      {
        runId: "20260901_000000_aborted",
        datasets: { hu_hu: { manifestFingerprint: "sha256:stale", endIndex: 0 } },
      },
    ]);

    expect(cursorsFrom(root, { hu_hu: entries }).get("hu_hu")).toBe(0);
  });
});

describe("--resume", () => {
  test("continues towards the recorded range instead of replanning from the cursor", () => {
    const entries = manifest(1000);
    const planned = planDataset("hu_hu", entries, 397, { kind: "delta", samples: 400 });

    expect(planned.startIndex).toBe(397);
    expect(planned.endIndex).toBe(797);

    // The run died after 100 of its clips, so the cursor now reads 497. Replanning
    // from that cursor would skip the 300 clips this run still owes.
    const partway = selectionFor(planned, 100);

    expect(partway.endIndex).toBe(497);
    expect(partway.plannedEndIndex).toBe(797);

    const resumed = resumePlan("hu_hu", entries, partway);

    expect(resumed.startIndex).toBe(397);
    expect(resumed.endIndex).toBe(797);
    expect(resumed.clips.map((entry) => entry.id)).toEqual(
      planned.clips.map((entry) => entry.id),
    );
  });
});

describe("the backfilled run on disk", () => {
  const runDir = resolve(import.meta.dir, "../results/20260902_181511_wispr-flow-all-400");

  test.skipIf(!existsSync(join(runDir, "results.json")))(
    "records consumable [0, 397) for each of its five datasets",
    async () => {
      const run = (await Bun.file(join(runDir, "results.json")).json()) as {
        results: Record<string, { samples: Array<{ warmup: boolean }>; selection?: DatasetSelection }>;
      };

      for (const [dataset, result] of Object.entries(run.results)) {
        expect(result.selection, dataset).toBeDefined();
        expect(result.selection!.startIndex, dataset).toBe(0);
        expect(result.selection!.endIndex, dataset).toBe(397);
        expect(result.selection!.plannedEndIndex, dataset).toBe(397);
        expect(result.selection!.warmupCount, dataset).toBe(WARMUP_COUNT);
        // 400 clips run, three of them the reserved warmups: 397 consumed.
        expect(result.samples.filter((sample) => !sample.warmup).length, dataset).toBe(397);
      }
    },
  );
});
