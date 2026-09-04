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
    stopToFirstTextMs: 200,
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
      stableMs: 750,
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
      config: {
        sampleSize: 5,
        warmupCount: 3,
        normalization: "whisper-basic",
        stableMs: 750,
      },
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

  test("averages each latency over the clips that measured it, not over every clip", () => {
    const run = runWith([
      // A warmup is excluded whatever it measured.
      sample(true, { stopToFirstTextMs: 9_000, stopToStableTextMs: 9_000 }),
      sample(false, { stopToFirstTextMs: 100, stopToStableTextMs: 1_000 }),
      sample(false, { stopToFirstTextMs: 300, stopToStableTextMs: 2_000 }),
      // Text arrived and never settled: a first-text time, no stable time. The two
      // means therefore run over different denominators, which is why each is
      // filtered separately rather than both over the same clip list.
      sample(false, { status: "timeout", stopToFirstTextMs: 800, stopToStableTextMs: null }),
    ]);
    run.config.samples = 4;

    const leaf =
      buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];
    expect(leaf.meanStopToFirstTextMs).toBe(400);
    expect(leaf.meanStopToStableTextMs).toBe(1_500);

    run.results["test-clean"]!.samples = [
      sample(false, { status: "timeout", stopToFirstTextMs: null, stopToStableTextMs: null }),
    ];
    run.config.samples = 1;
    // Absent rather than 0: nothing was measured, and 0 ms would read as instant.
    const nothing =
      buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];
    expect(nothing.meanStopToFirstTextMs).toBeUndefined();
    expect(nothing.meanStopToStableTextMs).toBeUndefined();
  });

  test("divides response time by only the audio that got an answer", () => {
    const run = runWith([
      // A warmup is excluded whatever it measured.
      sample(true, { audioDurationSec: 100, stopToFirstTextMs: 100 }),
      sample(false, { audioDurationSec: 2, stopToFirstTextMs: 200 }),
      sample(false, { audioDurationSec: 4, stopToFirstTextMs: 400 }),
      // Timed out with nothing pasted. Its 94 seconds must leave the denominator as
      // well as the numerator: keeping the audio while dropping the latency is the
      // same arithmetic as claiming the product answered it in 0 ms, which drags the
      // ratio down in exactly the datasets where the product did worst.
      sample(false, { audioDurationSec: 94, status: "timeout", stopToFirstTextMs: null }),
    ]);
    run.config.samples = 4;

    const leaf =
      buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];
    expect(leaf.totalStopToFirstTextMs).toBe(600);
    expect(leaf.respondedAudioSec).toBe(6);
    expect(leaf.responseMsPerAudioSec).toBe(100);
    // What the wrong denominator would have said, named so the difference is visible.
    expect(leaf.totalAudioSec).toBe(100);
    expect(leaf.totalStopToFirstTextMs! / leaf.totalAudioSec).toBe(6);

    run.results["test-clean"]!.samples = [
      sample(false, { status: "timeout", stopToFirstTextMs: null, stopToStableTextMs: null }),
    ];
    run.config.samples = 1;
    // Absent together rather than 0 ms/s, which would read as instant, or 0/0 NaN.
    const nothing =
      buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];
    expect(nothing.responseMsPerAudioSec).toBeUndefined();
    expect(nothing.totalStopToFirstTextMs).toBeUndefined();
    expect(nothing.respondedAudioSec).toBeUndefined();
  });

  test("keeps meanRTF off the comparable response figure", () => {
    const run = runWith([sample(false, { audioDurationSec: 2, wallClockMs: 3_000 })]);
    run.config.samples = 1;

    const leaf =
      buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];
    // meanRTF stays what the harness clocked, playback included. The two must not
    // converge: the comparable figure is in ms per audio second, meanRTF is floored at
    // 1.0 by playback the harness chose to do.
    expect(leaf.meanRTF).toBe(1.5);
    expect(leaf.responseMsPerAudioSec).toBe(100);
  });

  test("publishes the stability window its stable figure includes", () => {
    const run = runWith([sample(false)]);
    run.config.samples = 1;
    run.config.stableMs = 750;

    // The window is on every stable figure, because the harness stamps the timestamp
    // when the wait finishes. Published so a consumer can subtract it instead of
    // knowing it by heart.
    expect(buildCodictateResults(run).config.stableMs).toBe(750);
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

  const DATASETS = ["da_dk", "es_419", "hu_hu", "test-clean", "test-other"];

  test("publish the same stop-to-stable-text latency the run's own aggregate recorded", () => {
    const emitted = Object.fromEntries(
      Object.entries(leaves).map(([dataset, leaf]) => [
        dataset,
        leaf["external-product"]["wispr-flow"].meanStopToStableTextMs,
      ]),
    );
    const aggregated = Object.fromEntries(
      Object.entries(
        record.results as Record<string, { aggregate: { meanStopToStableTextMs: number } }>,
      ).map(([dataset, result]) => [dataset, result.aggregate.meanStopToStableTextMs]),
    );

    expect(Object.keys(emitted).sort()).toEqual(DATASETS);
    expect(emitted).toEqual(aggregated);
  });

  test("publish a first-text latency averaged over the clips that got text", () => {
    for (const dataset of DATASETS) {
      const samples = (
        record.results as Record<
          string,
          { samples: { warmup: boolean; stopToFirstTextMs: number | null }[] }
        >
      )[dataset].samples;
      const measured = samples
        .filter((s) => !s.warmup)
        .map((s) => s.stopToFirstTextMs)
        .filter((v): v is number => v !== null);
      const expected = measured.reduce((a, b) => a + b, 0) / measured.length;

      const leaf = leaves[dataset]["external-product"]["wispr-flow"];
      expect([dataset, leaf.meanStopToFirstTextMs]).toEqual([dataset, expected]);
      // The denominator is the clips that measured something, never all 397: hu_hu
      // timed out 13 times with nothing pasted, and averaging those as 0 would make
      // the slowest dataset read fastest.
      expect([dataset, measured.length]).toEqual([
        dataset,
        dataset === "hu_hu" ? 384 : dataset === "da_dk" ? 396 : 397,
      ]);
    }
  });

  test("publish a stable figure that is the first-text one plus the harness's window", () => {
    const stableMs = built.config.stableMs;
    expect(stableMs).toBe(750);

    for (const dataset of DATASETS) {
      const leaf = leaves[dataset]["external-product"]["wispr-flow"];
      // The window is the bulk of the gap between the two figures, which is the whole
      // reason the stable one must not be published as measured: the harness waits
      // 750 ms before stamping it, so it overstates the product by roughly that much.
      const corrected = leaf.meanStopToStableTextMs! - stableMs;
      expect([dataset, corrected - leaf.meanStopToFirstTextMs! < 100]).toEqual([dataset, true]);
      expect([dataset, corrected > leaf.meanStopToFirstTextMs!]).toEqual([dataset, true]);

      // And meanRTF is not any of these: the harness plays every clip at 1.0x real
      // time, so it cannot fall below 1.0 whatever the product does.
      expect([dataset, leaf.meanRTF > 1]).toEqual([dataset, true]);
    }
  });

  const RESPONSE_MS_PER_AUDIO_SEC: Record<string, number> = {
    "test-clean": 81,
    "test-other": 85,
    es_419: 61,
    da_dk: 190,
    hu_hu: 176,
  };

  test("publish the response time per audio second the run's own samples give", () => {
    for (const dataset of DATASETS) {
      const leaf = leaves[dataset]["external-product"]["wispr-flow"];
      expect([dataset, Math.round(leaf.responseMsPerAudioSec!)]).toEqual([
        dataset,
        RESPONSE_MS_PER_AUDIO_SEC[dataset],
      ]);
      // The published ratio is exactly its two published sums, so a consumer can pool
      // datasets without re-deriving anything from results.json.
      expect([dataset, leaf.totalStopToFirstTextMs! / leaf.respondedAudioSec!]).toEqual([
        dataset,
        leaf.responseMsPerAudioSec!,
      ]);
    }
  });

  test("drop a timed-out clip from both sides of the response ratio", () => {
    for (const dataset of DATASETS) {
      const samples = (
        record.results as Record<
          string,
          {
            samples: {
              warmup: boolean;
              status: string;
              audioDurationSec: number;
              stopToFirstTextMs: number | null;
            }[];
          }
        >
      )[dataset].samples;
      const scored = samples.filter((s) => !s.warmup);
      const answered = scored.filter((s) => s.stopToFirstTextMs !== null);
      const leaf = leaves[dataset]["external-product"]["wispr-flow"];

      expect([dataset, leaf.totalStopToFirstTextMs]).toEqual([
        dataset,
        answered.reduce((a, s) => a + s.stopToFirstTextMs!, 0),
      ]);
      // The denominator is the answered clips' audio, never totalAudioSec: da_dk and
      // hu_hu each lose the timed-out clips' seconds off the bottom too.
      expect([dataset, leaf.respondedAudioSec]).toEqual([
        dataset,
        answered.reduce((a, s) => a + s.audioDurationSec, 0),
      ]);
      const dropped = scored.length - answered.length;
      expect([dataset, dropped]).toEqual([
        dataset,
        dataset === "hu_hu" ? 13 : dataset === "da_dk" ? 1 : 0,
      ]);
      expect([dataset, leaf.respondedAudioSec! < leaf.totalAudioSec]).toEqual([
        dataset,
        dropped > 0,
      ]);
    }

    // Counting the 13 timed-out hu_hu clips as 0 ms instead would have published 168
    // and made the slowest dataset read faster than da_dk. Named so the shortcut
    // cannot come back unnoticed.
    const huHu = leaves["hu_hu"]["external-product"]["wispr-flow"];
    expect(Math.round(huHu.totalStopToFirstTextMs! / huHu.totalAudioSec)).toBe(168);
    expect(Math.round(huHu.responseMsPerAudioSec!)).toBe(176);
  });

  test("pool audio-weighted to the figure a consumer publishes", () => {
    const all = DATASETS.map((d) => leaves[d]["external-product"]["wispr-flow"]);
    const pooled =
      all.reduce((a, leaf) => a + leaf.totalStopToFirstTextMs!, 0) /
      all.reduce((a, leaf) => a + leaf.respondedAudioSec!, 0);
    expect(Math.round(pooled)).toBe(123);

    // Not the unweighted mean of the five ratios, which is what publishing only the
    // ratio per dataset would have invited.
    const unweighted =
      all.reduce((a, leaf) => a + leaf.responseMsPerAudioSec!, 0) / all.length;
    expect(Math.round(unweighted)).toBe(119);
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
