import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildCodictateResults,
  type CompatibleRun,
  type CompatibleSample,
} from "../src/codictate-compat";
import {
  INSTRUMENTATION_ASYMMETRY_LABEL,
  LEAF_SPEED_V2_FIELD,
  publishableWallRtf,
  v2OnV1LeafComplaints,
} from "../src/contract";

/**
 * Defect 5: the compatibility transform strips comparable speed.
 *
 * v1 removed every response-speed aggregate because the per-clip numbers behind them
 * held the harness's own output-device restore. The restore is out of the window now
 * and the bridge stamps both hotkey edges on the Z keydown transition, so a v2 run can
 * publish a pooled figure — and a v1 run must still publish none. Both halves are
 * asserted here, the second against the real archived run.
 *
 * Two fixture traps this file is written around:
 *
 * - A sample with **no** `overhead.timingRegime` is speed-incompatible, so a fixture
 *   that forgot the provenance would exercise the exclusion path while looking like it
 *   asserted arithmetic.
 * - A Flow fixture that accidentally *passes* the gate hides a real exclusion bug. So
 *   `v2Sample` and `legacySample` are separate helpers and neither defaults to the
 *   other's provenance.
 */
/**
 * A monotonic counter, so every fixture clip has a distinct **and reproducible** id.
 *
 * `Math.random()` was distinct but not reproducible: a failure could not be replayed,
 * and `pooledSampleCount` is one of the numbers under test, so identity is part of the
 * fixture rather than incidental to it.
 */
let fixtureClip = 0;

function v2Sample(overrides: Partial<CompatibleSample> = {}): CompatibleSample {
  return {
    warmup: false,
    status: "ok",
    clipId: `librispeech/wav/test-clean/v2-${fixtureClip++}.wav`,
    audioDurationSec: 2,
    wallClockMs: 3_000,
    audioPlaybackMs: 2_000,
    stopToLastTextChangeMs: 400,
    // Carries the 750 ms stability confirmation. Never the response metric.
    stopToStableTextMs: 1_150,
    timingClock: "monotonic",
    hotkeyEdge: "keydown",
    wer: { wer: 0, substitutions: 0, insertions: 0, deletions: 0, refWords: 4 },
    ...overrides,
  };
}

/** A clip measured before 2026-09-04: no response stamp, no provenance. */
function legacySample(overrides: Partial<CompatibleSample> = {}): CompatibleSample {
  return {
    warmup: false,
    status: "ok",
    clipId: `librispeech/wav/test-clean/legacy-${fixtureClip++}.wav`,
    audioDurationSec: 2,
    wallClockMs: 3_000,
    audioPlaybackMs: 2_000,
    stopToStableTextMs: 500,
    wer: { wer: 0, substitutions: 0, insertions: 0, deletions: 0, refWords: 4 },
    ...overrides,
  };
}

function runWith(samples: CompatibleSample[]): CompatibleRun {
  return {
    createdAt: "2026-09-04T00:00:00.000Z",
    product: { id: "wispr-flow", label: "Wispr Flow", version: "1.6.765" },
    hardware: { cpu: "Apple Test", ram: "32 GB", os: "macOS", osVersion: "26.0" },
    config: {
      datasets: ["test-clean"],
      samples: samples.length,
      leadMs: 500,
      tailMs: 500,
      stableMs: 750,
      configurationNote: "v2",
    },
    results: { "test-clean": { samples } },
  };
}

function leafOf(run: CompatibleRun) {
  return buildCodictateResults(run).librispeech["test-clean"]["external-product"]["wispr-flow"];
}

describe("the v2 speed summary the compatibility output now emits", () => {
  test("pools sum(responseMs)/sum(audioSec) rather than averaging per-clip ratios", () => {
    const leaf = leafOf(
      runWith([
        v2Sample({ audioDurationSec: 1, stopToLastTextChangeMs: 100 }),
        v2Sample({ audioDurationSec: 9, stopToLastTextChangeMs: 900 }),
      ]),
    );

    // Pooled: 1000 ms over 10 s = 100. A mean of the two per-clip ratios is also 100
    // here only because the ratios agree, so the discriminating case is below.
    expect(leaf.speedV2.responseMsPerAudioSec).toBe(100);
    expect(leaf.speedV2.wallRtf).toBe(0.1);
  });

  test("the pooled ratio is not the mean of per-clip ratios", () => {
    const leaf = leafOf(
      runWith([
        v2Sample({ audioDurationSec: 1, stopToLastTextChangeMs: 1_000 }),
        v2Sample({ audioDurationSec: 99, stopToLastTextChangeMs: 990 }),
      ]),
    );

    // Pooled: 1990 / 100 = 19.9. Mean of ratios: (1000 + 10) / 2 = 505.
    expect(leaf.speedV2.responseMsPerAudioSec).toBeCloseTo(19.9, 10);
    expect(leaf.speedV2.responseMsPerAudioSec).not.toBeCloseTo(505, 0);
  });

  test("uses the response metric, never the 750 ms-inclusive stable time", () => {
    const leaf = leafOf(
      runWith([v2Sample({ audioDurationSec: 2, stopToLastTextChangeMs: 400, stopToStableTextMs: 1_150 })]),
    );

    expect(leaf.speedV2.medianResponseMs).toBe(400);
    expect(leaf.speedV2.responseMsPerAudioSec).toBe(200);
    // 1150 / 2 = 575 would be the answer if the stable time had been substituted.
    expect(leaf.speedV2.responseMsPerAudioSec).not.toBe(575);
  });

  test("median averages the two middle values; p90 is nearest-rank", () => {
    const leaf = leafOf(
      runWith(
        [100, 200, 300, 400, 500, 600, 700, 800, 900, 1_000].map((ms) =>
          v2Sample({ stopToLastTextChangeMs: ms }),
        ),
      ),
    );

    expect(leaf.speedV2.medianResponseMs).toBe(550);
    expect(leaf.speedV2.p90ResponseMs).toBe(900);
  });

  test("only successful samples enter the ratio; the §N counts balance", () => {
    const leaf = leafOf(
      runWith([
        v2Sample({ audioDurationSec: 2, stopToLastTextChangeMs: 400 }),
        v2Sample({
          status: "timeout",
          audioDurationSec: 30,
          stopToLastTextChangeMs: null,
        }),
        v2Sample({
          status: "failed",
          audioDurationSec: 30,
          stopToLastTextChangeMs: null,
        }),
        v2Sample({ warmup: true, audioDurationSec: 2, stopToLastTextChangeMs: 1 }),
      ]),
    );

    expect(leaf.speedV2.responseMsPerAudioSec).toBe(200);
    expect(leaf.speedV2).toMatchObject({
      attemptedCount: 3,
      respondedCount: 1,
      failureCount: 2,
      timeoutCount: 1,
      speedExcludedCount: 0,
    });
    // failureCount includes timeouts; timeoutCount is the subset (SPEC addendum §N).
    expect(leaf.speedV2.attemptedCount).toBe(
      leaf.speedV2.respondedCount + leaf.speedV2.failureCount,
    );
  });

  test("a pre-fix Flow sample is excluded from the ratio and counted as excluded", () => {
    const leaf = leafOf(
      runWith([
        v2Sample({ audioDurationSec: 2, stopToLastTextChangeMs: 1_000 }),
        legacySample({ audioDurationSec: 2, stopToStableTextMs: 100 }),
      ]),
    );

    // 1000 / 2 = 500. Pooling the flattering legacy clip would have read 275.
    expect(leaf.speedV2.responseMsPerAudioSec).toBe(500);
    expect(leaf.speedV2.responseMsPerAudioSec).not.toBe(275);
    expect(leaf.speedV2).toMatchObject({
      attemptedCount: 2,
      respondedCount: 2,
      speedExcludedCount: 1,
      failureCount: 0,
    });
    // The excluded sample is still a measurement of accuracy and of coverage.
    expect(leaf.utteranceCount).toBe(2);
    expect(leaf.referenceWords).toBe(8);
  });

  test("a run made entirely of pre-fix samples publishes no figure and says why", () => {
    const leaf = leafOf(runWith([legacySample(), legacySample(), legacySample()]));

    expect(leaf.speedV2.responseMsPerAudioSec).toBeNull();
    expect(leaf.speedV2.wallRtf).toBeNull();
    expect(leaf.speedV2.medianResponseMs).toBeNull();
    expect(leaf.speedV2.p90ResponseMs).toBeNull();
    expect(leaf.speedV2.speedExcludedCount).toBe(3);
    expect(leaf.speedV2.respondedCount).toBe(3);
  });

  test("the wall RTF comes from the filtered ratio, not an unfiltered one", () => {
    const leaf = leafOf(
      runWith([
        v2Sample({ audioDurationSec: 10, stopToLastTextChangeMs: 3_000 }),
        legacySample({ audioDurationSec: 10, stopToStableTextMs: 100 }),
      ]),
    );

    expect(leaf.speedV2.wallRtf).toBeCloseTo(0.3, 10);
    // The unfiltered sums give 3100 / 20 = 155 ms/s, i.e. 0.155.
    expect(leaf.speedV2.wallRtf).not.toBeCloseTo(0.155, 3);
  });

  test("F4: the summary is under speedV2, and a bare `speed` is refused", () => {
    // The name is load-bearing. This harness wrote `speed`, Codictate wrote `speedV2`,
    // and `charts.py` reads `speedV2` - so every external row found nothing and fell
    // through to a `meanRTF` fallback: a differently defined, unfiltered,
    // playback-floored number rendered in a v2 chart at up to 28x the contract value.
    const leaf = leafOf(runWith([v2Sample()])) as unknown as Record<string, unknown>;

    expect(LEAF_SPEED_V2_FIELD).toBe("speedV2");
    expect(LEAF_SPEED_V2_FIELD in leaf).toBe(true);
    expect("speed" in leaf).toBe(false);
    // And the leaf satisfies the shape both repositories agreed on.
    expect(v2OnV1LeafComplaints(leaf, { pooledRunCount: 1 })).toEqual([]);
  });

  test("F4: meanRTF keeps its v1 meaning and never stands in for the v2 figure", () => {
    // A run of nothing but pre-fix clips: no publishable v2 speed, but `meanRTF` is
    // still the session wall clock over audio across every scored sample, exactly as
    // v1 computed it and as the archive recorded it.
    const leaf = leafOf(
      runWith([
        legacySample({ audioDurationSec: 2, wallClockMs: 3_000 }),
        legacySample({ audioDurationSec: 2, wallClockMs: 3_000 }),
      ]),
    );

    expect(leaf.meanRTF).toBe(1.5);
    expect(leaf.totalAudioSec).toBe(4);
    expect(leaf.totalWallSec).toBe(6);
    expect(leaf.speedV2.wallRtf).toBeNull();
    // `publishableWallRtf` is the function that refuses the fallback `charts.py` made.
    expect(publishableWallRtf(leaf)).toBeNull();
    expect(publishableWallRtf(leaf)).not.toBe(leaf.meanRTF);
  });

  test("F4: the leaf publishes wordErrors as an integer, not as wer x referenceWords", () => {
    // Codictate wrote it and this harness did not, so one product's numerator was an
    // exact integer and the other's a derived float, pooled into one published rate.
    const leaf = leafOf(
      runWith([
        v2Sample({ wer: { wer: 0.25, substitutions: 1, insertions: 0, deletions: 0, refWords: 4 } }),
        v2Sample({ wer: { wer: 0.5, substitutions: 1, insertions: 1, deletions: 0, refWords: 4 } }),
      ]),
    );

    expect(leaf.wordErrors).toBe(3);
    expect(Number.isInteger(leaf.wordErrors)).toBe(true);
    expect(leaf.referenceWords).toBe(8);
    expect(leaf.wer).toBeCloseTo(3 / 8, 12);
  });

  test("F11: a sample with no identity is refused, never collapsed to a placeholder", () => {
    // `?? "unknown"` made every sample in such a record one clip, so
    // `speedV2.sampleCount` read 1 for a 400-clip dataset.
    expect(() =>
      leafOf(
        runWith([
          { ...v2Sample(), clipId: undefined, audioPath: undefined },
          { ...v2Sample(), clipId: undefined, audioPath: undefined },
        ]),
      ),
    ).toThrow(/carries neither clipId nor audioPath/);

    // An `audioPath` alone is enough: on a committed record it IS the clipId string.
    const leaf = leafOf(
      runWith([
        { ...v2Sample(), clipId: undefined, audioPath: "fleurs/da_dk/audio/test/a.wav" },
        { ...v2Sample(), clipId: undefined, audioPath: "fleurs/da_dk/audio/test/b.wav" },
      ]),
    );
    expect(leaf.speedV2.sampleCount).toBe(2);
  });

  test("the instrumentation asymmetry is stated in the output, character for character", () => {
    // SPEC §5 and addendum §J: any surface that shows both products must say this.
    const built = buildCodictateResults(runWith([v2Sample()]));
    expect(built.instrumentationNote).toBe(INSTRUMENTATION_ASYMMETRY_LABEL);
  });
});

describe("the archived Wispr Flow run", () => {
  // results/20260902_181511_wispr-flow-all-400 was measured with the pre-fix
  // instrumentation: 81-90 ms optimistic per clip, in Flow's favour. It stays readable,
  // contributes accuracy, and must contribute nothing to pooled speed.
  const record = JSON.parse(
    readFileSync(
      resolve(import.meta.dir, "../results/20260902_181511_wispr-flow-all-400/results.json"),
      "utf8",
    ),
  ) as CompatibleRun;
  const built = buildCodictateResults(record);
  const leaves = { ...built.librispeech, ...built.fleurs };

  test("publishes no pooled speed figure at all", () => {
    expect(Object.keys(leaves).sort()).toEqual([
      "da_dk",
      "es_419",
      "hu_hu",
      "test-clean",
      "test-other",
    ]);
    for (const [dataset, harnesses] of Object.entries(leaves)) {
      const speed = harnesses["external-product"]["wispr-flow"].speedV2;
      expect([dataset, speed.responseMsPerAudioSec]).toEqual([dataset, null]);
      expect([dataset, speed.wallRtf]).toEqual([dataset, null]);
      expect([dataset, speed.medianResponseMs]).toEqual([dataset, null]);
      expect([dataset, speed.p90ResponseMs]).toEqual([dataset, null]);
    }
  });

  test("says how many samples it excluded, rather than dropping them silently", () => {
    for (const [dataset, harnesses] of Object.entries(leaves)) {
      const leaf = harnesses["external-product"]["wispr-flow"];
      // Every clip that responded was excluded: the whole run predates the fix.
      expect([dataset, leaf.speedV2.speedExcludedCount]).toEqual([
        dataset,
        leaf.speedV2.respondedCount,
      ]);
      expect([dataset, leaf.speedV2.speedExcludedCount > 0]).toEqual([dataset, true]);
    }
  });

  test("still contributes accuracy and coverage, and its counts still balance", () => {
    for (const [dataset, harnesses] of Object.entries(leaves)) {
      const leaf = harnesses["external-product"]["wispr-flow"];
      expect([dataset, leaf.referenceWords > 0]).toEqual([dataset, true]);
      expect([dataset, leaf.speedV2.attemptedCount]).toEqual([
        dataset,
        leaf.speedV2.respondedCount + leaf.speedV2.failureCount,
      ]);
      expect([dataset, leaf.speedV2.attemptedCount]).toEqual([dataset, leaf.utteranceCount]);
    }
    // The run timed out 13 hu_hu clips; they are failures, not exclusions.
    expect(leaves["hu_hu"]["external-product"]["wispr-flow"].speedV2.timeoutCount).toBe(13);
    expect(leaves["hu_hu"]["external-product"]["wispr-flow"].speedV2.failureCount).toBe(13);
  });
});
