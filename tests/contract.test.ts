import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertResumeFlags,
  assertUniqueClipIds,
  buildRunPlan,
  clipIdFromAbsoluteAudioPath,
  clipIdFromRelativeAudioPath,
  compatibilityKey,
  contiguousCursor,
  FINGERPRINT_VERSION,
  fingerprintV2,
  fingerprintV2Matches,
  fingerprintV2Record,
  fleursClipId,
  INSTRUMENTATION_ASYMMETRY_LABEL,
  isFingerprintV2,
  librispeechClipId,
  maxMeasuredEnd,
  median,
  overlaps,
  p90,
  pooledCer,
  pooledSpeed,
  pooledWer,
  poolSamples,
  normalizeRunRecordV2,
  pooledInferenceRtf,
  RESUME_FORBIDDEN_FLAGS,
  resumeSelection,
  responseMsFromWindow,
  SCHEMA_VERSION,
  seriesSamples,
  speedCompatible,
  stabilityConfirmedAtMs,
  STABILITY_DELAY_MS,
  uniqueInOrder,
  wallRtfFromResponseRatio,
  type RunRecordV2,
  type SampleMeasurementV2,
} from "../src/contract";

/**
 * The golden parity fixtures, read off disk and never recomputed.
 *
 * `tests/fixtures/fingerprint-v2.json` is a verbatim copy of
 * `codictate/benchmarks/contract/fixtures/fingerprint-v2.json`. SPEC §2 forbids this
 * repository from regenerating the expected values: a fixture that recomputes itself
 * agrees with any implementation, including a wrong one, which is the single thing it
 * exists to rule out. If a case below fails, the mirror in `src/contract/` has forked
 * from the canonical module and that is a parity bug to report, not a fixture to
 * refresh.
 */
interface FingerprintFixture {
  version: string;
  cases: Array<{ name: string; clipIds: string[]; fingerprint: string }>;
}

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dir, "fixtures/fingerprint-v2.json"), "utf8"),
) as FingerprintFixture;

function fixtureCase(name: string) {
  const found = fixture.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`Golden fixture has no case named "${name}"`);
  return found;
}

describe("fingerprint v2 golden parity fixtures", () => {
  test("the copied fixture is the benchmark-v2 algorithm's", () => {
    expect(fixture.version).toBe(FINGERPRINT_VERSION);
    expect(FINGERPRINT_VERSION).toBe("benchmark-v2");
  });

  test("every case matches, case by case", () => {
    // Named individually as well as looped, so a failure report says which case.
    const computed = fixture.cases.map((entry) => ({
      name: entry.name,
      fingerprint: fingerprintV2(entry.clipIds),
    }));
    expect(computed).toEqual(
      fixture.cases.map((entry) => ({
        name: entry.name,
        fingerprint: entry.fingerprint,
      })),
    );
  });

  for (const name of [
    "empty",
    "single",
    "order-matters-a",
    "order-matters-b",
    "dedup",
    "unicode",
    "real-fleurs-da-first-5",
  ]) {
    test(`case "${name}"`, () => {
      const entry = fixtureCase(name);
      expect(fingerprintV2(entry.clipIds)).toBe(entry.fingerprint);
    });
  }

  test("dedup equals order-matters-b, which IS the assertion", () => {
    expect(fixtureCase("dedup").fingerprint).toBe(
      fixtureCase("order-matters-b").fingerprint,
    );
    expect(fingerprintV2(["a.wav", "a.wav", "b.wav"])).toBe(
      fingerprintV2(["a.wav", "b.wav"]),
    );
  });

  test("order matters: the two orderings differ", () => {
    expect(fixtureCase("order-matters-a").fingerprint).not.toBe(
      fixtureCase("order-matters-b").fingerprint,
    );
    expect(fingerprintV2(["b.wav", "a.wav"])).not.toBe(
      fingerprintV2(["a.wav", "b.wav"]),
    );
  });

  test("the real da_dk five are the clipIds the addendum pins", () => {
    // Also proves fleursClipId agrees with the fixture's derivation: TSV column 1.
    expect(fixtureCase("real-fleurs-da-first-5").clipIds).toEqual([
      "fleurs/da_dk/audio/test/12149430079508542992.wav",
      "fleurs/da_dk/audio/test/1892314626509120692.wav",
      "fleurs/da_dk/audio/test/11657230937236500261.wav",
      "fleurs/da_dk/audio/test/10016401698104160032.wav",
      "fleurs/da_dk/audio/test/15945042231538223000.wav",
    ]);
    expect(
      fixtureCase("real-fleurs-da-first-5").clipIds.map((clipId) =>
        fleursClipId("da_dk", clipId.split("/").at(-1)!),
      ),
    ).toEqual(fixtureCase("real-fleurs-da-first-5").clipIds);
  });
});

describe("fingerprint v2 on-disk shape", () => {
  test("carries both halves: the field name AND the embedded version", () => {
    // SPEC addendum §A. Not one or the other.
    const record = fingerprintV2Record(["a.wav", "b.wav"]);
    expect(record).toEqual({
      version: "benchmark-v2",
      value: fixtureCase("order-matters-b").fingerprint,
    });
    expect(isFingerprintV2(record)).toBe(true);
  });

  test("rejects a bare hex string and a v1 <count>:<hex> fingerprint", () => {
    expect(isFingerprintV2("fe6e1a10333a02a4")).toBe(false);
    expect(isFingerprintV2({ version: "benchmark-v2", value: "2:abc" })).toBe(false);
    expect(isFingerprintV2({ value: "fe6e1a10333a02a4" })).toBe(false);
  });

  test("matching is version-checked, never coerced", () => {
    expect(fingerprintV2Matches(fingerprintV2Record(["a.wav"]), ["a.wav"])).toBe(true);
    expect(fingerprintV2Matches(fingerprintV2(["a.wav"]), ["a.wav"])).toBe(false);
  });

  test("the schema version key constant is 2", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });
});

describe("clip identity", () => {
  test("FLEURS and LibriSpeech clipIds are corpus-relative POSIX paths", () => {
    expect(fleursClipId("da_dk", "12149430079508542992.wav")).toBe(
      "fleurs/da_dk/audio/test/12149430079508542992.wav",
    );
    expect(librispeechClipId("test-clean", "1272-128104-0000")).toBe(
      "librispeech/wav/test-clean/1272-128104-0000.wav",
    );
    expect(librispeechClipId("test-clean", "1272-128104-0000.wav")).toBe(
      librispeechClipId("test-clean", "1272-128104-0000"),
    );
  });

  test("normalises separators, ./ and a leading slash to one spelling", () => {
    const canonical = "fleurs/da_dk/audio/test/a.wav";
    expect(clipIdFromRelativeAudioPath("fleurs\\da_dk\\audio\\test\\a.wav")).toBe(canonical);
    expect(clipIdFromRelativeAudioPath("./fleurs/da_dk/audio/test/a.wav")).toBe(canonical);
    expect(clipIdFromRelativeAudioPath("/fleurs/da_dk/audio/test/a.wav")).toBe(canonical);
  });

  test("identity conversion throws where portableAudioPath falls back to basename", () => {
    // SPEC addendum §K. The fallback is right for a portable record and catastrophic
    // as identity: a bare file name would pool one clip as two, or two as one.
    expect(() => clipIdFromAbsoluteAudioPath("/elsewhere/a.wav", "/root/datasets")).toThrow(
      /not under the datasets root/,
    );
    expect(() => clipIdFromRelativeAudioPath("C:\\clips\\17.wav")).toThrow(/absolute path/);
    expect(() => clipIdFromRelativeAudioPath("../outside/a.wav")).toThrow(/escape the datasets root/);
    expect(clipIdFromAbsoluteAudioPath("/root/datasets/fleurs/da_dk/audio/test/a.wav", "/root/datasets")).toBe(
      "fleurs/da_dk/audio/test/a.wav",
    );
  });

  test("uniqueInOrder keeps the first occurrence", () => {
    expect(uniqueInOrder(["b", "a", "b", "c", "a"])).toEqual(["b", "a", "c"]);
  });

  test("a duplicate in a plan is refused, naming both indices", () => {
    expect(() => assertUniqueClipIds(["a", "b", "a"], "plan")).toThrow(
      /plan names the same clip twice: "a" at index 0 and index 2/,
    );
  });
});

describe("timing", () => {
  test("the 750 ms stability delay is outside the response window", () => {
    const window = {
      regime: "ui-observed-paste",
      startedAtMs: 1_000,
      lastTextChangeAtMs: 2_500,
      observation: "text-change-event",
      stabilityDelayMs: STABILITY_DELAY_MS,
    } as const;
    expect(STABILITY_DELAY_MS).toBe(750);
    expect(responseMsFromWindow(window)).toBe(1_500);
    expect(stabilityConfirmedAtMs(window) - window.startedAtMs).toBe(2_250);
    expect(responseMsFromWindow(window)).toBeLessThan(
      stabilityConfirmedAtMs(window) - window.startedAtMs,
    );
  });

  test("the asymmetry label is printed character for character", () => {
    // SPEC addendum §J. Verbatim, not a paraphrase.
    expect(INSTRUMENTATION_ASYMMETRY_LABEL).toBe(
      "Response times are not measured the same way for both products: Codictate is timed at " +
        "the direct adapter call boundary, Wispr Flow is timed from the UI-observed paste.",
    );
  });
});

describe("selection primitives", () => {
  const plan = buildRunPlan({
    runId: "r1",
    datasetId: "fleurs/da_dk",
    harness: "wispr-flow",
    model: "wispr-flow",
    consumableClipIds: ["c0", "c1", "c2", "c3", "c4"],
    fromIndex: 0,
    toIndex: 5,
    warmupClipIds: ["w0", "w1", "w2"],
    createdAt: "2026-09-04T00:00:00.000Z",
  });

  test("a gap does not advance the contiguous cursor; maxMeasuredEnd reports it", () => {
    const measured = ["c0", "c1", "c4"];
    expect(contiguousCursor(plan.orderedClipIds, measured)).toBe(2);
    expect(maxMeasuredEnd(plan.orderedClipIds, measured)).toBe(5);
  });

  test("overlap is on clip sets, warmups ignored", () => {
    const other = buildRunPlan({
      runId: "r2",
      datasetId: "fleurs/da_dk",
      harness: "wispr-flow",
      model: "wispr-flow",
      consumableClipIds: ["c5", "c6"],
      fromIndex: 0,
      toIndex: 2,
      warmupClipIds: ["w0", "w1", "w2"],
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    expect(overlaps(plan, other)).toBe(false);
  });

  test("RESUME_FORBIDDEN_FLAGS is exactly the thirteen, and excludes --batch/--out", () => {
    expect([...RESUME_FORBIDDEN_FLAGS]).toEqual([
      "--from",
      "--to",
      "--samples",
      "--limit",
      "--clips-per-dataset",
      "--dataset",
      "--datasets",
      "--languages",
      "--splits",
      "--model",
      "--models",
      "--seed",
      "--smoke",
    ]);
    expect(() => assertResumeFlags(["--batch", "2026-09-v2", "--out", "x"], "r1")).not.toThrow();
    expect(() => assertResumeFlags(["--samples=20"], "r1")).toThrow(/--samples cannot be combined/);
  });

  test("resume replays every warmup and skips recorded failures and timeouts", () => {
    const samples: SampleMeasurementV2[] = [
      sample("c0", { isWarmup: false, status: "ok" }),
      sample("c1", { isWarmup: false, status: "timeout", responseMs: null }),
      sample("c2", { isWarmup: false, status: "failed", responseMs: null }),
      sample("w0", { isWarmup: true }),
    ];
    const selection = resumeSelection(plan, samples);
    expect(selection.warmupsToReplay).toEqual(["w0", "w1", "w2"]);
    expect(selection.scoredToSkip).toEqual(["c0", "c1", "c2"]);
    expect(selection.remaining).toEqual(["c3", "c4"]);
  });
});

/**
 * A v2 Sample of the shape this harness writes: UI-observed regime, both provenance
 * stamps present.
 *
 * The stamps are in the default rather than added per case because SPEC addendum §R
 * makes an absent `timingRegime` speed-incompatible, so a helper that omitted them
 * would silently make every speed assertion below assert nothing.
 */
function sample(
  clipId: string,
  overrides: Partial<SampleMeasurementV2> = {},
): SampleMeasurementV2 {
  return {
    clipId,
    audioDurationSec: 2,
    responseMs: 200,
    status: "ok",
    wordErrors: 1,
    referenceWords: 10,
    charErrors: 2,
    referenceChars: 50,
    isWarmup: false,
    overhead: {
      timingRegime: "ui-observed-paste",
      hotkeyEdge: "keydown",
      timingClock: "monotonic",
    },
    ...overrides,
  };
}

function run(overrides: Partial<RunRecordV2> = {}): RunRecordV2 {
  const samples = overrides.samples ?? [sample("c0")];
  const clipIds = samples.filter((entry) => !entry.isWarmup).map((entry) => entry.clipId);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: "r1",
    status: "completed",
    startedAt: "2026-09-04T00:00:00.000Z",
    completedAt: "2026-09-04T01:00:00.000Z",
    harness: "wispr-flow",
    model: "wispr-flow",
    datasetId: "fleurs/da_dk",
    plan: {
      runId: overrides.runId ?? "r1",
      datasetId: "fleurs/da_dk",
      fromIndex: 0,
      toIndex: clipIds.length,
      clipCount: clipIds.length,
      fingerprintV2: fingerprintV2Record(clipIds),
      createdAt: "2026-09-04T00:00:00.000Z",
    },
    fingerprintV2: fingerprintV2Record(clipIds),
    ...overrides,
    samples,
  };
}

describe("pooling buckets by compatibility rather than throwing", () => {
  // SPEC addendum §D and §Q. Both products measure the same clip on purpose.
  const flowRun = run({
    runId: "flow-1",
    harness: "wispr-flow",
    model: "wispr-flow",
    samples: [sample("fleurs/da_dk/audio/test/a.wav")],
  });
  const codictateRun = run({
    runId: "codictate-1",
    harness: "codictate",
    model: "large-v3-q5_0",
    samples: [sample("fleurs/da_dk/audio/test/a.wav")],
  });

  test("two harnesses measuring one clip pool into two buckets, no throw", () => {
    const pooled = poolSamples([flowRun, codictateRun]);
    expect(pooled.buckets.map((bucket) => bucket.key)).toEqual([
      compatibilityKey(codictateRun),
      compatibilityKey(flowRun),
    ]);
    expect(pooled.buckets.every((bucket) => bucket.samples.length === 1)).toBe(true);
    expect(pooled.buckets.every((bucket) => bucket.replaced.length === 0)).toBe(true);
    // Deterministic regardless of read order.
    expect(poolSamples([codictateRun, flowRun]).buckets.map((bucket) => bucket.key)).toEqual(
      pooled.buckets.map((bucket) => bucket.key),
    );
  });

  test("an incomplete run contributes nothing at all", () => {
    const pooled = poolSamples([
      { ...flowRun, runId: "flow-partial", status: "incomplete", completedAt: null },
    ]);
    expect(pooled.buckets).toEqual([]);
    expect(pooled.skippedRuns).toEqual([{ runId: "flow-partial", reason: "incomplete" }]);
  });

  test("disjoint continuations pool; an overlapping rerun replaces only the overlap", () => {
    const first = run({
      runId: "flow-1",
      samples: [sample("a.wav", { responseMs: 100 }), sample("b.wav", { responseMs: 100 })],
    });
    const second = run({
      runId: "flow-2",
      completedAt: "2026-09-05T00:00:00.000Z",
      samples: [sample("b.wav", { responseMs: 900 }), sample("c.wav", { responseMs: 900 })],
    });
    const bucket = poolSamples([first, second]).buckets[0];
    expect(bucket.samples.map((entry) => entry.clipId)).toEqual(["a.wav", "b.wav", "c.wav"]);
    expect(bucket.samples.map((entry) => entry.responseMs)).toEqual([100, 900, 900]);
    expect(bucket.samples.map((entry) => entry.runId)).toEqual(["flow-1", "flow-2", "flow-2"]);
    expect(bucket.replaced).toEqual([
      { clipId: "b.wav", keptRunId: "flow-2", droppedRunId: "flow-1" },
    ]);
  });

  test("seriesSamples sums one product across datasets, never across products", () => {
    const danish = run({
      runId: "flow-da",
      datasetId: "fleurs/da_dk",
      samples: [sample("fleurs/da_dk/audio/test/a.wav", { wordErrors: 1, referenceWords: 10 })],
    });
    const hungarian = run({
      runId: "flow-hu",
      datasetId: "fleurs/hu_hu",
      samples: [sample("fleurs/hu_hu/audio/test/a.wav", { wordErrors: 4, referenceWords: 40 })],
    });
    const pooled = poolSamples([danish, hungarian, codictateRun]);
    const series = seriesSamples(pooled, { harness: "wispr-flow", model: "wispr-flow" });
    expect(series).toHaveLength(2);
    expect(pooledWer(series)).toMatchObject({ errors: 5, references: 50 });
  });

  test("normalizeRunRecordV2 rewrites the SCHEMA_VERSION alias and drops it", () => {
    const raw = { SCHEMA_VERSION: 2, runId: "aliased" } as Record<string, unknown>;
    const normalised = normalizeRunRecordV2(raw) as Record<string, unknown>;
    expect(normalised.schemaVersion).toBe(2);
    expect("SCHEMA_VERSION" in normalised).toBe(false);
    expect(normalizeRunRecordV2(null)).toBeNull();
    expect(normalizeRunRecordV2([1, 2])).toEqual([1, 2]);
  });
});

describe("pooled accuracy and speed", () => {
  test("WER and CER are pooled sums, never a mean of means", () => {
    const leaves = [
      { wordErrors: 1, referenceWords: 100, charErrors: 1, referenceChars: 500 },
      { wordErrors: 4, referenceWords: 10, charErrors: 8, referenceChars: 50 },
    ];
    expect(pooledWer(leaves).rate).toBeCloseTo(5 / 110, 12);
    expect(pooledCer(leaves).rate).toBeCloseTo(9 / 550, 12);
    // The mean of the two rates is 0.205 - a different number, and not this one.
    expect(pooledWer(leaves).rate).not.toBeCloseTo(0.205, 3);
  });

  test("a leaf with no denominator is skipped, never counted as zero", () => {
    const pooled = pooledWer([
      { wordErrors: 1, referenceWords: 100 },
      { wordErrors: 5 },
      { referenceWords: 50 },
    ]);
    expect(pooled).toMatchObject({ errors: 1, references: 100, leafCount: 1, skippedCount: 2 });
  });

  test("median averages the two middle values; p90 is nearest-rank", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([1, 2, 3])).toBe(2);
    expect(median([])).toBeNull();
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
    expect(p90([])).toBeNull();
  });

  test("only successful samples enter the ratio; §N counts balance", () => {
    const summary = pooledSpeed([
      sample("a", { responseMs: 100, audioDurationSec: 1 }),
      sample("b", { responseMs: 300, audioDurationSec: 2 }),
      sample("c", { status: "timeout", responseMs: null, audioDurationSec: 30 }),
      sample("d", { status: "failed", responseMs: null, audioDurationSec: 30 }),
      sample("w", { isWarmup: true, responseMs: 1, audioDurationSec: 1 }),
    ]);
    expect(summary.responseMsPerAudioSec).toBeCloseTo(400 / 3, 12);
    expect(summary.wallRtf).toBeCloseTo(400 / 3 / 1000, 12);
    expect(summary.wallRtf).toBe(wallRtfFromResponseRatio(summary.responseMsPerAudioSec));
    expect(summary.medianResponseMs).toBe(200);
    expect(summary.p90ResponseMs).toBe(300);
    expect(summary).toMatchObject({
      attemptedCount: 4,
      respondedCount: 2,
      speedExcludedCount: 0,
      failureCount: 2,
      timeoutCount: 1,
      sampleCount: 4,
    });
    // SPEC addendum §N, nested not disjoint.
    expect(summary.attemptedCount).toBe(summary.respondedCount + summary.failureCount);
  });

  test('status "ok" with a null responseMs is a failure, not a fast clip', () => {
    // SPEC addendum §H: malformed, not fast. Excluded from the ratio and from
    // respondedCount, so the §N identity still holds without a fourth counter.
    const summary = pooledSpeed([
      sample("a", { responseMs: 100, audioDurationSec: 1 }),
      sample("b", { responseMs: null, audioDurationSec: 5 }),
    ]);
    expect(summary.responseMsPerAudioSec).toBe(100);
    expect(summary.respondedCount).toBe(1);
    expect(summary.attemptedCount).toBe(2);
    expect(summary.failureCount).toBe(1);
    expect(summary.timeoutCount).toBe(0);
  });

  test("speedCompatible is regime-aware, so a direct-adapter sample is not gated", () => {
    // SPEC addendum §R: a naive hotkeyEdge/timingClock filter would exclude every
    // Codictate sample, because a direct-adapter window has no hotkey at all.
    expect(speedCompatible({ overhead: { timingRegime: "direct-adapter" } })).toBe(true);
    expect(
      speedCompatible({
        overhead: {
          timingRegime: "ui-observed-paste",
          hotkeyEdge: "keydown",
          timingClock: "monotonic",
        },
      }),
    ).toBe(true);
    // Pre-fix Flow: 81-90 ms optimistic per clip, measured.
    expect(speedCompatible({ overhead: { timingRegime: "ui-observed-paste" } })).toBe(false);
    expect(
      speedCompatible({
        overhead: { timingRegime: "ui-observed-paste", hotkeyEdge: "keydown" },
      }),
    ).toBe(false);
    expect(
      speedCompatible({
        overhead: { timingRegime: "ui-observed-paste", timingClock: "monotonic" },
      }),
    ).toBe(false);
    // Absent regime is conservative: excluded rather than guessed.
    expect(speedCompatible({ overhead: { hotkeyEdge: "keydown", timingClock: "monotonic" } })).toBe(
      false,
    );
    expect(speedCompatible({})).toBe(false);
  });

  test("a pre-fix Flow sample leaves the speed ratio and keeps every other number", () => {
    // SPEC addendum §L and §R: the instrumentation defect moved a timestamp, not a
    // transcript, so the sample still responded and its WER is still valid.
    const v2 = sample("v2.wav", {
      responseMs: 1_000,
      audioDurationSec: 5,
      overhead: {
        timingRegime: "ui-observed-paste",
        hotkeyEdge: "keydown",
        timingClock: "monotonic",
      },
    });
    // A clip from before 2026-09-04: no regime, no edge, no clock. Deliberately the
    // flattering one, so including it would show up as a faster pooled figure.
    const legacy = sample("legacy.wav", {
      responseMs: 100,
      audioDurationSec: 5,
      overhead: undefined,
    });

    const summary = pooledSpeed([v2, legacy]);
    expect(summary.responseMsPerAudioSec).toBe(200);
    expect(summary.wallRtf).toBe(0.2);
    expect(summary.medianResponseMs).toBe(1_000);
    // Pooling both would have published 110 ms per audio second instead of 200.
    expect(summary.responseMsPerAudioSec).not.toBe(110);
    expect(summary).toMatchObject({
      attemptedCount: 2,
      respondedCount: 2,
      speedExcludedCount: 1,
      failureCount: 0,
      sampleCount: 2,
    });
    expect(summary.attemptedCount).toBe(summary.respondedCount + summary.failureCount);
    // Accuracy is untouched by the speed filter.
    expect(pooledWer([v2, legacy])).toMatchObject({ errors: 2, references: 20, skippedCount: 0 });
  });

  test("the Codictate-only inference RTF skips samples with no inferenceMs", () => {
    // SPEC addendum §I: a diagnostic, never the headline speed.
    const pooled = pooledInferenceRtf([
      sample("a", { audioDurationSec: 2, overhead: { inferenceMs: 500 } }),
      sample("b", { audioDurationSec: 8 }),
    ]);
    expect(pooled).toMatchObject({ inferenceMs: 500, audioDurationSec: 2, leafCount: 1, skippedCount: 1 });
    expect(pooled.rtf).toBeCloseTo(0.25, 12);
  });
});
