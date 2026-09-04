import { describe, expect, test } from "bun:test";
import {
  buildCodictateCheckpoint,
  buildCodictateResults,
  type CompatibleRun,
} from "../src/codictate-compat";

function sample(warmup: boolean, overrides: Record<string, unknown> = {}) {
  return {
    warmup,
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
