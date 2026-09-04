import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveCursors,
  formatPlanLine,
  incompleteRunsFor,
  manifestFingerprint,
  planDataset,
  resumePlan,
  scanRunRecords,
  selectionFor,
  consumableEntries,
  type DatasetSelection,
} from "../src/selection";
import { assertNoOverlappingIncompleteRun, fingerprintV2 } from "../src/contract";
import type { ManifestEntry } from "../src/types";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(count: number, prefix = "clip"): ManifestEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${index}`,
    clipId: `librispeech/wav/test-clean/${prefix}-${index}.wav`,
    audioPath: `/tmp/${prefix}-${index}.wav`,
    transcript: "reference",
    language: "en",
    audioDurationSec: 2,
  }));
}

/** A results tree of the shape the runner writes, with an explicit run status. */
function resultsTree(
  runs: Array<{
    runId: string;
    status?: "running" | "completed";
    datasets: Record<string, Partial<DatasetSelection> & { manifestFingerprint: string; endIndex: number }>;
  }>,
): string {
  const root = mkdtempSync(join(tmpdir(), "v2-selection-"));
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
        status: run.status ?? "completed",
        product: { id: "wispr-flow", label: "Wispr Flow", version: "1.6.765" },
        results,
      }),
    );
  }
  return root;
}

function cursorsFrom(root: string, entries: Record<string, ManifestEntry[]>): Map<string, number> {
  const records = scanRunRecords(root, { productId: "wispr-flow" });
  return deriveCursors(
    records,
    new Map(
      Object.entries(entries).map(([dataset, list]) => [
        dataset,
        { fingerprint: manifestFingerprint(list), entryCount: list.length },
      ]),
    ),
    "/tmp/datasets",
  );
}

describe("defect 3: only completed runs feed the production cursor", () => {
  const entries = manifest(1_000);
  const fingerprint = manifestFingerprint(entries);

  test("an interrupted run does not advance the cursor", () => {
    const root = resultsTree([
      { runId: "a-completed", status: "completed", datasets: { hu_hu: { manifestFingerprint: fingerprint, endIndex: 200 } } },
      { runId: "b-running", status: "running", datasets: { hu_hu: { manifestFingerprint: fingerprint, endIndex: 700 } } },
    ]);

    // The 700 belongs to a process that has not finished and has not been checked
    // against its plan. It is a resume source, not a measurement.
    expect(cursorsFrom(root, { hu_hu: entries }).get("hu_hu")).toBe(200);
  });

  test("a record with no status at all is treated as incomplete, not as completed", () => {
    const root = mkdtempSync(join(tmpdir(), "v2-selection-nostatus-"));
    temporaryRoots.push(root);
    mkdirSync(join(root, "unknown"), { recursive: true });
    writeFileSync(
      join(root, "unknown", "results.json"),
      JSON.stringify({
        runId: "unknown",
        product: { id: "wispr-flow", label: "Wispr Flow", version: null },
        results: { hu_hu: { samples: [], selection: { manifestFingerprint: fingerprint, endIndex: 900 } } },
      }),
    );

    expect(cursorsFrom(root, { hu_hu: entries }).get("hu_hu")).toBe(0);
  });

  test("the incomplete runs are still reported, so a resume can be offered", () => {
    const root = resultsTree([
      {
        runId: "b-running",
        status: "running",
        datasets: {
          hu_hu: { manifestFingerprint: fingerprint, endIndex: 400, startIndex: 200, plannedEndIndex: 700 },
        },
      },
    ]);
    const records = scanRunRecords(root, { productId: "wispr-flow" });

    expect(records.map((record) => [record.runId, record.status])).toEqual([
      ["b-running", "incomplete"],
    ]);
    expect(incompleteRunsFor(records, "hu_hu", entries)).toEqual([
      {
        runId: "b-running",
        orderedClipIds: consumableEntries(entries)
          .slice(200, 700)
          .map((entry) => entry.clipId),
      },
    ]);
  });

  test("a new overlapping run is blocked, naming the run id to resume or discard", () => {
    const root = resultsTree([
      {
        runId: "b-running",
        status: "running",
        datasets: {
          hu_hu: { manifestFingerprint: fingerprint, endIndex: 400, startIndex: 200, plannedEndIndex: 700 },
        },
      },
    ]);
    const records = scanRunRecords(root, { productId: "wispr-flow" });
    const incomplete = incompleteRunsFor(records, "hu_hu", entries);

    // Starting at the honest cursor 0 with depth 400 walks straight into [200, 700).
    const plan = planDataset("hu_hu", entries, 0, { kind: "target", to: 400 });
    expect(() =>
      assertNoOverlappingIncompleteRun(
        { orderedClipIds: plan.clips.map((entry) => entry.clipId) },
        incomplete,
      ),
    ).toThrow(/Run b-running is incomplete and shares 200 clip\(s\)/);

    // A genuinely disjoint continuation is allowed.
    const disjoint = planDataset("hu_hu", entries, 700, { kind: "target", to: 900 });
    expect(() =>
      assertNoOverlappingIncompleteRun(
        { orderedClipIds: disjoint.clips.map((entry) => entry.clipId) },
        incomplete,
      ),
    ).not.toThrow();
  });
});

describe("defect 12: a gap must not advance the cursor", () => {
  const entries = manifest(1_000);

  test("--from past the cursor leaves the cursor where it was", () => {
    const plan = planDataset("hu_hu", entries, 397, { kind: "target", to: 900 }, 600);

    expect(plan.gap).toBe(true);
    expect(plan.startIndex).toBe(600);
    expect(plan.endIndex).toBe(900);
    // Clips 397-599 were never transcribed, so "measured 900 deep" is a claim about
    // clips nobody has heard.
    expect(plan.cursorAfter).toBe(397);
    expect(plan.maxMeasuredEndAfter).toBe(900);
  });

  test("a forward run and a rewind both still advance the contiguous cursor", () => {
    const forward = planDataset("hu_hu", entries, 397, { kind: "target", to: 900 });
    expect(forward.gap).toBe(false);
    expect(forward.cursorAfter).toBe(900);
    expect(forward.maxMeasuredEndAfter).toBe(900);

    const rewind = planDataset("hu_hu", entries, 397, { kind: "target", to: 200 }, 0);
    expect(rewind.rewind).toBe(true);
    expect(rewind.cursorAfter).toBe(397);
    expect(rewind.maxMeasuredEndAfter).toBe(397);
  });

  test("the recorded selection separates the contiguous cursor from the gap-inclusive end", () => {
    const plan = planDataset("hu_hu", entries, 397, { kind: "target", to: 900 }, 600);
    const selection = selectionFor(plan, 300);

    expect(selection.endIndex).toBe(900);
    expect(selection.contiguousEndIndex).toBe(397);
    expect(selection.maxMeasuredEndIndex).toBe(900);
    expect(selection.priorCursor).toBe(397);
  });

  test("a recorded gap does not advance the cursor of the next run either", () => {
    const fingerprint = manifestFingerprint(entries);
    const plan = planDataset("hu_hu", entries, 397, { kind: "target", to: 900 }, 600);
    const selection = selectionFor(plan, 300);
    const root = resultsTree([
      {
        runId: "gap-run",
        status: "completed",
        datasets: { hu_hu: { ...selection, manifestFingerprint: fingerprint } },
      },
    ]);

    // The old `Math.max(cursor, endIndex)` recorded 900 here, and the next run started
    // at 900 - permanently skipping clips 397-599.
    expect(cursorsFrom(root, { hu_hu: entries }).get("hu_hu")).toBe(397);
  });

  test("the GAP preview line keeps its voice and reports both numbers honestly", () => {
    const line = formatPlanLine(planDataset("hu_hu", entries, 397, { kind: "target", to: 900 }, 600));

    expect(line).toContain("GAP --from 600 starts past cursor 397");
    expect(line).toContain("leaving clips 398-600 unmeasured");
    expect(line).toContain("cursor ends at 397");
    expect(line).toContain("maxMeasuredEnd 900, not contiguous");
  });

  test("a legacy record with no contiguousEndIndex is read at its endIndex", () => {
    // Every committed v1 record starts at index 0, so its endIndex IS its contiguous
    // prefix. The fallback is exact for the archive and is documented as such.
    const fingerprint = manifestFingerprint(entries);
    const root = resultsTree([
      {
        runId: "legacy",
        status: "completed",
        datasets: { hu_hu: { manifestFingerprint: fingerprint, endIndex: 397, startIndex: 0 } },
      },
    ]);

    expect(cursorsFrom(root, { hu_hu: entries }).get("hu_hu")).toBe(397);
  });
});

describe("defect 10: the recorded selection carries a v2 clip fingerprint", () => {
  const entries = manifest(50);

  test("it covers the selected scored clips, with warmups excluded", () => {
    const plan = planDataset("hu_hu", entries, 0, { kind: "target", to: 10 });
    const selection = selectionFor(plan, 10);
    const scoredClipIds = plan.clips.map((entry) => entry.clipId);

    expect(selection.clipFingerprintV2).toEqual({
      version: "benchmark-v2",
      value: fingerprintV2(scoredClipIds),
    });
    // SPEC addendum §F: the opposite convention from the v1 manifestFingerprint, which
    // covers the whole pool *including* the warmups. Never compare the two.
    expect(selection.clipFingerprintV2.value).not.toBe(
      fingerprintV2([...plan.warmups.map((entry) => entry.clipId), ...scoredClipIds]),
    );
    expect(selection.manifestFingerprint.startsWith("sha256:")).toBe(true);
  });

  test("two runs over the same range fingerprint the same, a shifted range does not", () => {
    const a = selectionFor(planDataset("hu_hu", entries, 0, { kind: "target", to: 10 }), 10);
    const b = selectionFor(planDataset("hu_hu", entries, 10, { kind: "target", to: 10 }, 0), 10);
    const shifted = selectionFor(planDataset("hu_hu", entries, 1, { kind: "target", to: 11 }), 10);

    expect(a.clipFingerprintV2.value).toBe(b.clipFingerprintV2.value);
    expect(a.clipFingerprintV2.value).not.toBe(shifted.clipFingerprintV2.value);
  });
});

describe("resume keeps the range it recorded and the cursor it earned", () => {
  const entries = manifest(1_000);

  test("a resumed gap run still reports the non-contiguous end separately", () => {
    const original = selectionFor(
      planDataset("hu_hu", entries, 397, { kind: "target", to: 900 }, 600),
      120,
    );
    const resumed = resumePlan("hu_hu", entries, original);

    expect(resumed.startIndex).toBe(600);
    expect(resumed.endIndex).toBe(900);
    expect(resumed.cursorAfter).toBe(397);
    expect(resumed.maxMeasuredEndAfter).toBe(900);
  });
});
