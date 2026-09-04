import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCodictateCheckpoint,
  buildCodictateResults,
  type CompatibleRun,
  type CompatibleSample,
} from "../src/codictate-compat";

function sample(warmup: boolean, overrides: Record<string, unknown> = {}) {
  return {
    warmup,
    // Narrowed, since an override supplies the failing statuses and the helper's own
    // inferred `string` would not fit the sample type.
    status: "ok" as CompatibleSample["status"],
    audioDurationSec: 2,
    wallClockMs: 3_000,
    audioPlaybackMs: 2_000,
    stopToStableTextMs: 500,
    wer: { wer: 0, substitutions: 0, insertions: 0, deletions: 0, refWords: 4 },
    ...overrides,
  };
}

function runWith(samples: ReturnType<typeof sample>[]): CompatibleRun {
  return {
    createdAt: "2026-09-02T00:00:00.000Z",
    product: { id: "wispr-flow", label: "Wispr Flow", version: "1.2.3" },
    hardware: { cpu: "Apple Test", ram: "32 GB", os: "macOS", osVersion: "26.0" },
    config: {
      datasets: ["test-clean"],
      samples: 5,
      leadMs: 500,
      tailMs: 500,
      configurationNote: "Auto-detect",
    },
    results: { "test-clean": { samples } },
  };
}

describe("Codictate-compatible artifacts", () => {
  test("writes Codictate result fields from scored samples only", () => {
    const run = runWith([
      sample(true),
      sample(true),
      sample(true),
      sample(false, {
        wer: { wer: 0.25, substitutions: 1, insertions: 0, deletions: 0, refWords: 4 },
      }),
      sample(false, {
        audioDurationSec: 3,
        wallClockMs: 4_000,
        wer: { wer: 0.5, substitutions: 0, insertions: 1, deletions: 1, refWords: 4 },
      }),
    ]);

    expect(buildCodictateResults(run)).toMatchObject({
      description: "Wispr Flow 1.2.3 external-product benchmark; Auto-detect",
      runDate: "2026-09-02T00:00:00.000Z",
      config: { sampleSize: 5, warmupCount: 3, normalization: "whisper-basic" },
      librispeech: {
        "test-clean": {
          "external-product": {
            "wispr-flow": {
              wer: 0.375,
              referenceWords: 8,
              meanRTF: 1.4,
              peakRSS_MB: null,
              utteranceCount: 2,
              totalAudioSec: 5,
              totalWallSec: 7,
            },
          },
        },
      },
      fleurs: {},
    });

    run.completedAt = "2026-09-02T01:00:00.000Z";
    expect(buildCodictateResults(run).runDate).toBe(run.completedAt);
  });

  test("publishes the denominators the rates were divided by", () => {
    const run = runWith([
      sample(false, {
        wer: { wer: 0.25, substitutions: 1, insertions: 0, deletions: 0, refWords: 4 },
        cer: { cer: 0.1, substitutions: 2, insertions: 0, deletions: 0, refChars: 20 },
      }),
      sample(false, {
        wer: { wer: 0.5, substitutions: 0, insertions: 1, deletions: 1, refWords: 4 },
        cer: { cer: 0.2, substitutions: 1, insertions: 1, deletions: 2, refChars: 20 },
      }),
    ]);
    run.config.samples = 2;

    const leaf =
      buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];

    // The point of publishing the denominator: the rate times the count is the error
    // count, so any set of leaves can be re-pooled without re-running anything.
    expect(leaf.referenceWords).toBe(8);
    expect(leaf.wer * leaf.referenceWords).toBeCloseTo(3, 10);
    expect(leaf.referenceChars).toBe(40);
    expect(leaf.cer! * leaf.referenceChars!).toBeCloseTo(6, 10);
  });

  test("omits referenceChars where there is no cer to divide", () => {
    const run = runWith([sample(false)]);
    run.config.samples = 1;

    const leaf =
      buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];
    expect(leaf.cer).toBeUndefined();
    expect(leaf.referenceChars).toBeUndefined();
    expect(leaf.referenceWords).toBe(4);
  });

  test("publishes the failures a consumer cannot derive", () => {
    const run = runWith([
      // A warmup failure is not part of the scored sample, so it is not counted.
      sample(true, { status: "timeout" }),
      sample(false),
      sample(false, { status: "timeout" }),
      sample(false, { status: "timeout" }),
      sample(false, { status: "failed" }),
    ]);

    const leaf =
      buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];

    // The reason the count has to be published: a failed clip is scored as an empty
    // hypothesis, so it is still an utterance and `sampleSize - warmupCount -
    // utteranceCount` sees nothing wrong.
    expect(leaf.utteranceCount).toBe(4);
    expect(run.config.samples - 3 - leaf.utteranceCount).toBe(-2);
    expect(leaf.failures).toBe(3);
    expect(leaf.failuresByStatus).toEqual({ timeout: 2, failed: 1 });
  });

  test("publishes a zeroed breakdown when nothing failed", () => {
    const run = runWith([sample(false)]);
    run.config.samples = 1;

    const leaf =
      buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];
    expect(leaf.failures).toBe(0);
    expect(leaf.failuresByStatus).toEqual({ timeout: 0, failed: 0 });
  });

  test("checkpoints Codictate partial totals and promotes completed dataset", () => {
    const run = runWith([
      sample(true),
      sample(true),
      sample(true),
      sample(false, {
        wer: { wer: 0.25, substitutions: 1, insertions: 0, deletions: 0, refWords: 4 },
      }),
    ]);

    expect(buildCodictateCheckpoint(run, "test-clean")).toMatchObject({
      harnesses: ["external-product"],
      librispeech: {},
      fleurs: {},
      inProgress: {
        harness: "external-product",
        modelId: "wispr-flow",
        datasetKey: "test-clean",
        datasetType: "librispeech",
        partial: {
          utterancesDone: 1,
          totalWer: 1,
          totalRefWords: 4,
          totalAudioSec: 2,
          totalWallSec: 3,
        },
      },
    });

    run.results["test-clean"]!.samples.push(sample(false));
    const completed = buildCodictateCheckpoint(run, "test-clean");
    expect(completed.inProgress).toBeUndefined();
    expect(
      completed.librispeech["test-clean"]?.["external-product"]["wispr-flow"].utteranceCount,
    ).toBe(2);
  });
});

describe("committed run records", () => {
  const runDir = resolve(import.meta.dir, "../results/20260902_181511_wispr-flow-all-400");
  const record = JSON.parse(readFileSync(resolve(runDir, "results.json"), "utf8"));
  const built = buildCodictateResults(record as CompatibleRun);
  const leaves = { ...built.librispeech, ...built.fleurs };

  test("publish the same failure count the run's own aggregate recorded", () => {
    const emitted = Object.fromEntries(
      Object.entries(leaves).map(([dataset, leaf]) => [
        dataset,
        leaf["external-product"]["wispr-flow"].failures,
      ]),
    );
    const aggregated = Object.fromEntries(
      Object.entries(record.results as Record<string, { aggregate: { failures: number } }>).map(
        ([dataset, result]) => [dataset, result.aggregate.failures],
      ),
    );

    expect(emitted).toEqual(aggregated);
    // Named rather than only compared, so the run that motivated the field cannot go
    // back to reporting a clean sweep without a test saying so.
    expect(emitted["hu_hu"]).toBe(13);
    expect(emitted["da_dk"]).toBe(1);
    expect(emitted["test-clean"]).toBe(0);
  });

  test("publish a breakdown that adds back up to the failure count", () => {
    for (const [dataset, harnesses] of Object.entries(leaves)) {
      const leaf = harnesses["external-product"]["wispr-flow"];
      expect([dataset, leaf.failuresByStatus.timeout + leaf.failuresByStatus.failed]).toEqual([
        dataset,
        leaf.failures,
      ]);
    }

    // Every failure in this run was the clip running out its budget, not the product
    // erroring, and the site is meant to be able to say so.
    expect(leaves["hu_hu"]["external-product"]["wispr-flow"].failuresByStatus).toEqual({
      timeout: 13,
      failed: 0,
    });
  });
});
