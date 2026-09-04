import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runPlanFor, sessionSelection, datasetIdOf } from "../src/v2-plan";
import { RESUME_FORBIDDEN_FLAGS, resumeSelection } from "../src/contract";
import { WARMUP_COUNT, type DatasetSelection } from "../src/selection";
import type { ManifestEntry } from "../src/types";
import type { SampleMeasurementV2 } from "../src/contract";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(count: number): ManifestEntry[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `clip-${index}`,
    clipId: `fleurs/da_dk/audio/test/${index}.wav`,
    audioPath: `/tmp/${index}.wav`,
    transcript: "reference",
    language: "da",
    audioDurationSec: 2,
  }));
}

const entries = manifest(20);
const plan = runPlanFor({
  runId: "20260904_000000_resume-test",
  model: "wispr-flow",
  dataset: "da_dk",
  entries,
  fromIndex: 0,
  toIndex: 10,
  createdAt: "2026-09-04T00:00:00.000Z",
});

describe("defect 6: resume replays warmups and never repeats a scored clip", () => {
  test("the plan reserves the manifest head as warmups, disjoint from the scored range", () => {
    expect(plan.warmupClipIds).toEqual(
      entries.slice(0, WARMUP_COUNT).map((entry) => entry.clipId),
    );
    expect(plan.orderedClipIds).toEqual(
      entries.slice(WARMUP_COUNT, WARMUP_COUNT + 10).map((entry) => entry.clipId),
    );
    // Index 0 of the plan is the first clip *after* the Warmup Reservation
    // (SPEC addendum §E), so no clip is ever both warmed and scored.
    expect(
      plan.warmupClipIds.filter((clipId) => plan.orderedClipIds.includes(clipId)),
    ).toEqual([]);
  });

  test("every warmup replays on a fresh session, with nothing captured", () => {
    const session = sessionSelection(plan, []);

    expect(session.warmupsToReplay).toEqual(plan.warmupClipIds);
    expect(session.scoredToSkip).toEqual([]);
    expect(session.remaining).toEqual(plan.orderedClipIds);
  });

  test("every warmup replays again on a resumed session, however deep it is", () => {
    // This is the bug. The completed-id filter used to remove the warmups too, because
    // they were in the same set as the scored clips, so a resumed session's first real
    // clip became its warmup and the model was measured stone cold.
    const captured = plan.orderedClipIds.slice(0, 6);
    const session = sessionSelection(plan, [...captured, ...plan.warmupClipIds]);

    expect(session.warmupsToReplay).toEqual(plan.warmupClipIds);
    expect(session.warmupsToReplay).toHaveLength(WARMUP_COUNT);
    expect(session.scoredToSkip).toEqual(captured);
    expect(session.remaining).toEqual(plan.orderedClipIds.slice(6));
  });

  test("a completed scored clip is never re-transcribed", () => {
    const session = sessionSelection(plan, plan.orderedClipIds);

    expect(session.remaining).toEqual([]);
    expect(session.scoredToSkip).toEqual(plan.orderedClipIds);
    // The warmups still replay: there is nothing left to score, so a caller that sees
    // an empty `remaining` skips the dataset entirely rather than warming for nothing.
    expect(session.warmupsToReplay).toEqual(plan.warmupClipIds);
  });

  test("remaining stays in plan order, which is what makes the cursor advance", () => {
    const outOfOrder = [
      plan.orderedClipIds[7],
      plan.orderedClipIds[1],
      plan.orderedClipIds[0],
    ];
    const session = sessionSelection(plan, outOfOrder);

    expect(session.remaining).toEqual([
      plan.orderedClipIds[2],
      plan.orderedClipIds[3],
      plan.orderedClipIds[4],
      plan.orderedClipIds[5],
      plan.orderedClipIds[6],
      plan.orderedClipIds[8],
      plan.orderedClipIds[9],
    ]);
  });

  test("a recorded failure or timeout counts as measured and is NOT replayed", () => {
    // SPEC addendum §G. A recorded failure is a counted measurement: it sits in
    // attemptedCount and failureCount and contributes nothing to speed. Replaying it
    // until it passes would launder it, and replaying it once would double-count it.
    const samples: SampleMeasurementV2[] = [
      measurement(plan.orderedClipIds[0], "ok"),
      measurement(plan.orderedClipIds[1], "timeout"),
      measurement(plan.orderedClipIds[2], "failed"),
    ];
    const session = resumeSelection(plan, samples);

    expect(session.scoredToSkip).toEqual(plan.orderedClipIds.slice(0, 3));
    expect(session.remaining).toEqual(plan.orderedClipIds.slice(3));
  });

  test("a recorded warmup does not count as a measured scored clip", () => {
    const samples: SampleMeasurementV2[] = [
      { ...measurement(plan.warmupClipIds[0], "ok"), isWarmup: true },
      { ...measurement(plan.orderedClipIds[0], "ok"), isWarmup: true },
    ];
    const session = resumeSelection(plan, samples);

    // A warmup-flagged sample of a scored clip cannot happen in a real record, and if
    // it did it must not retire the clip: it was never scored.
    expect(session.scoredToSkip).toEqual([]);
    expect(session.remaining).toEqual(plan.orderedClipIds);
  });
});

function measurement(clipId: string, status: "ok" | "timeout" | "failed"): SampleMeasurementV2 {
  return {
    clipId,
    audioDurationSec: 2,
    responseMs: status === "ok" ? 400 : null,
    status,
    wordErrors: 0,
    referenceWords: 4,
    charErrors: 0,
    referenceChars: 20,
    isWarmup: false,
    overhead: {
      timingRegime: "ui-observed-paste",
      hotkeyEdge: "keydown",
      timingClock: "monotonic",
    },
  };
}

describe("dataset ids both repositories key on", () => {
  test("carry the corpus, so they cannot collide across corpora", () => {
    expect(datasetIdOf("test-clean")).toBe("librispeech/test-clean");
    expect(datasetIdOf("test-other")).toBe("librispeech/test-other");
    expect(datasetIdOf("da_dk")).toBe("fleurs/da_dk");
    expect(datasetIdOf("es_419")).toBe("fleurs/es_419");
    expect(datasetIdOf("hu_hu")).toBe("fleurs/hu_hu");
  });

  test("prefix every clipId in the dataset, which is what makes a mislabel detectable", () => {
    expect(plan.datasetId).toBe("fleurs/da_dk");
    expect(plan.orderedClipIds.every((clipId) => clipId.startsWith(`${plan.datasetId}/`))).toBe(
      true,
    );
  });
});

// -- CLI-level: defect 3 --

async function runCli(...args: string[]) {
  const root = resolve(import.meta.dir, "..");
  const child = Bun.spawn(["bun", resolve(root, "src/runner.ts"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** A results tree holding one run, so a test can point `--out` at it. */
function resultsTreeWith(run: {
  runId: string;
  status: "running" | "completed";
  selection: Partial<DatasetSelection> & { manifestFingerprint: string; endIndex: number };
  dataset: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), "v2-resume-cli-"));
  temporaryRoots.push(root);
  const runDir = join(root, run.runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "results.json"),
    JSON.stringify({
      runId: run.runId,
      status: run.status,
      product: { id: "wispr-flow", label: "Wispr Flow", version: "1.6.765" },
      results: { [run.dataset]: { samples: [], selection: run.selection } },
    }),
  );
  return root;
}

describe("defect 3: resume is explicit and refuses every selection-changing flag", () => {
  for (const flag of RESUME_FORBIDDEN_FLAGS) {
    // `--from` has its own older, more specific message and is asserted separately in
    // tests/runner.test.ts; the rest are refused by name here.
    if (flag === "--from") continue;
    test(`${flag} cannot be combined with --resume`, async () => {
      const value = flag === "--smoke" ? [] : ["1"];
      const { exitCode, stderr } = await runCli(
        "--resume",
        "some-run-id",
        flag,
        ...(flag === "--datasets" || flag === "--dataset" ? ["da_dk"] : value),
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain(`${flag} cannot be combined with a resume`);
    });
  }

  test("--batch and --out are deliberately allowed on a resume", async () => {
    // The orchestrator passes `--batch` on every invocation including the resuming
    // ones, and `--out` moves where a report is written rather than what was measured.
    const { exitCode, stderr } = await runCli(
      "--resume",
      "no-such-run",
      "--batch",
      "2026-09-v2",
      "--out",
      "results",
    );

    expect(exitCode).toBe(1);
    expect(stderr).not.toContain("cannot be combined with a resume");
    expect(stderr).toContain("--resume no-such-run names no run");
  });

  test("a resume that names no run says where it looked, rather than starting a new run", async () => {
    const { exitCode, stderr } = await runCli("--resume", "20990101_000000_imaginary");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("names no run");
    expect(stderr).toContain("Looked for a results.json in:");
    expect(stderr).toContain("A resume never searches for the latest unfinished run");
  });
});

describe("defect 3: a new run overlapping an unfinished one is blocked", () => {
  const datasetsDir = resolve(import.meta.dir, "../../codictate/benchmarks/datasets");

  test.skipIf(!Bun.file(join(datasetsDir, "fleurs/da_dk/test.tsv")).size)(
    "the error names the incomplete run id and tells the operator what to do",
    async () => {
      // The incomplete run claims consumable [0, 400) of da_dk. A new run at the
      // honest cursor 0 would walk straight into it.
      const { buildManifest } = await import("../src/manifest");
      const { manifestFingerprint } = await import("../src/selection");
      const fingerprint = manifestFingerprint(buildManifest(datasetsDir, "da_dk"));
      const root = resultsTreeWith({
        runId: "20260904_000000_partial",
        status: "running",
        dataset: "da_dk",
        selection: {
          selectionVersion: 2,
          manifestFingerprint: fingerprint,
          startIndex: 0,
          endIndex: 120,
          contiguousEndIndex: 120,
          maxMeasuredEndIndex: 120,
          plannedEndIndex: 400,
        },
      });

      const { exitCode, stderr } = await runCli(
        "--name",
        "would-overlap",
        "--datasets",
        "da_dk",
        "--to",
        "400",
        "--out",
        root,
        "--dry-run",
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain("Run 20260904_000000_partial is incomplete");
      expect(stderr).toContain("Resume it with its run id, or discard it");
    },
  );
});
