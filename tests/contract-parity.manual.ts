/**
 * Direct parity between `src/contract/` and the canonical module it mirrors.
 *
 * `src/contract/index.ts` explains why this repository mirrors the contract rather than
 * importing it. The cost of a mirror is that it can drift, and the golden fixtures in
 * `tests/contract.test.ts` only pin the fingerprint. This file pins the rest: it loads
 * the *canonical* modules out of the sibling Codictate checkout and compares them
 * function by function on the same inputs.
 *
 * A `.manual.ts` file for the same reason `tests/fleurs-identity.manual.ts` is one: it
 * needs a checkout CI does not have, and it is deliberately loaded through a **computed
 * specifier** so `tsc --noEmit` does not pull a second repository into this one's
 * type-check graph. Run it whenever the canonical module changes:
 *
 * ```bash
 * bun test ./tests/contract-parity.manual.ts
 * ```
 *
 * A failure here is a real parity bug. Re-copy the canonical module into
 * `src/contract/`, re-read the mirror headers, and re-run this and
 * `tests/contract.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as mirror from "../src/contract";

const canonicalDir = resolve(
  import.meta.dir,
  "../../codictate/benchmarks/contract",
);
const canonicalIndex = resolve(canonicalDir, "index.ts");

// Computed rather than literal, so this file type-checks without the sibling checkout.
const specifier = pathToFileURL(canonicalIndex).href;

describe.skipIf(!existsSync(canonicalIndex))("mirror vs canonical", () => {
  let canonical: Record<string, unknown>;

  async function load(): Promise<Record<string, unknown>> {
    canonical ??= (await import(specifier)) as Record<string, unknown>;
    return canonical;
  }

  test("every constant is identical", async () => {
    const contract = await load();
    // `same` rather than `expect(...).toBe(...)` because the canonical module is loaded
    // through a computed specifier and is therefore `unknown` to the type-checker —
    // which is the point: this file must type-check on a checkout that has no sibling
    // repository. The runtime comparison is exact.
    same(mirror.FINGERPRINT_VERSION, contract.FINGERPRINT_VERSION);
    same(mirror.SCHEMA_VERSION, contract.SCHEMA_VERSION);
    same(mirror.SCHEMA_VERSION_KEY, contract.SCHEMA_VERSION_KEY);
    same(mirror.STABILITY_DELAY_MS, contract.STABILITY_DELAY_MS);
    same(mirror.FLEURS_SPLIT, contract.FLEURS_SPLIT);
    same(mirror.HOTKEY_EDGE_KEYDOWN, contract.HOTKEY_EDGE_KEYDOWN);
    same(mirror.TIMING_CLOCK_MONOTONIC, contract.TIMING_CLOCK_MONOTONIC);
    same(mirror.INSTRUMENTATION_ASYMMETRY_LABEL, contract.INSTRUMENTATION_ASYMMETRY_LABEL);
    same([...mirror.RESUME_FORBIDDEN_FLAGS], [
      ...(contract.RESUME_FORBIDDEN_FLAGS as readonly string[]),
    ]);
    same([...mirror.SAMPLE_STATUSES], [...(contract.SAMPLE_STATUSES as readonly string[])]);
    same([...mirror.RUN_STATUSES], [...(contract.RUN_STATUSES as readonly string[])]);
    same(mirror.TIMING_REGIME_LABELS, contract.TIMING_REGIME_LABELS);
  });

  test("the mirror re-exports at least everything the canonical index does", async () => {
    const contract = await load();
    const missing = Object.keys(contract).filter((name) => !(name in mirror));
    expect(missing).toEqual([]);
  });

  test("fingerprintV2 agrees on every shape that has ever caused trouble", async () => {
    const contract = await load();
    const fingerprint = contract.fingerprintV2 as (ids: readonly string[]) => string;
    const cases: string[][] = [
      [],
      ["a.wav"],
      ["b.wav", "a.wav"],
      ["a.wav", "b.wav"],
      ["a.wav", "a.wav", "b.wav"],
      ["fleurs/da_dk/audio/test/æøå.wav"],
      ["fleurs/da_dk/audio/test/12149430079508542992.wav"],
      Array.from({ length: 400 }, (_unused, index) => `fleurs/da_dk/audio/test/${index}.wav`),
    ];
    for (const clipIds of cases) {
      expect([clipIds.length, mirror.fingerprintV2(clipIds)]).toEqual([
        clipIds.length,
        fingerprint(clipIds),
      ]);
    }
  });

  test("clip identity agrees, including on the paths it must refuse", async () => {
    const contract = await load();
    const fleurs = contract.fleursClipId as (locale: string, file: string) => string;
    const libri = contract.librispeechClipId as (split: string, id: string) => string;
    const fromRelative = contract.clipIdFromRelativeAudioPath as (path: string) => string;
    const fromAbsolute = contract.clipIdFromAbsoluteAudioPath as (
      path: string,
      root: string,
    ) => string;

    expect(mirror.fleursClipId("da_dk", "1.wav")).toBe(fleurs("da_dk", "1.wav"));
    expect(mirror.librispeechClipId("test-clean", "1272-128104-0000")).toBe(
      libri("test-clean", "1272-128104-0000"),
    );
    expect(mirror.clipIdFromRelativeAudioPath(".\\a\\b.wav")).toBe(fromRelative(".\\a\\b.wav"));
    expect(mirror.clipIdFromAbsoluteAudioPath("/r/d/a.wav", "/r/d")).toBe(
      fromAbsolute("/r/d/a.wav", "/r/d"),
    );
    for (const bad of ["C:\\clips\\17.wav", "../outside.wav", ""]) {
      const mirrorThrew = threw(() => mirror.clipIdFromRelativeAudioPath(bad));
      expect([bad, mirrorThrew]).toEqual([bad, threw(() => fromRelative(bad))]);
    }
  });

  test("cursors, overlap and resume agree", async () => {
    const contract = await load();
    const ordered = ["c0", "c1", "c2", "c3", "c4"];
    const measured = ["c0", "c1", "c4"];
    expect(mirror.contiguousCursor(ordered, measured)).toBe(
      (contract.contiguousCursor as typeof mirror.contiguousCursor)(ordered, measured),
    );
    expect(mirror.maxMeasuredEnd(ordered, measured)).toBe(
      (contract.maxMeasuredEnd as typeof mirror.maxMeasuredEnd)(ordered, measured),
    );

    const input = {
      runId: "r1",
      datasetId: "fleurs/da_dk",
      harness: "wispr-flow",
      model: "wispr-flow",
      consumableClipIds: ordered,
      fromIndex: 1,
      toIndex: 4,
      warmupClipIds: ["w0", "w1", "w2"],
      createdAt: "2026-09-04T00:00:00.000Z",
    };
    const mirrorPlan = mirror.buildRunPlan(input);
    const canonicalPlan = (contract.buildRunPlan as typeof mirror.buildRunPlan)(input);
    expect(mirrorPlan).toEqual(canonicalPlan);
    expect(mirror.runPlanRef(mirrorPlan)).toEqual(
      (contract.runPlanRef as typeof mirror.runPlanRef)(canonicalPlan),
    );
  });

  test("median, p90 and the speed predicate agree", async () => {
    const contract = await load();
    const values = [5, 1, 4, 2, 3, 9, 8, 7, 6, 10];
    expect(mirror.median(values)).toBe((contract.median as typeof mirror.median)(values));
    expect(mirror.p90(values)).toBe((contract.p90 as typeof mirror.p90)(values));
    expect(mirror.median([])).toBe((contract.median as typeof mirror.median)([]));

    const speedCompatible = contract.speedCompatible as typeof mirror.speedCompatible;
    const overheads = [
      undefined,
      {},
      { timingRegime: "direct-adapter" as const },
      { timingRegime: "ui-observed-paste" as const },
      { timingRegime: "ui-observed-paste" as const, hotkeyEdge: "keydown" },
      {
        timingRegime: "ui-observed-paste" as const,
        hotkeyEdge: "keydown",
        timingClock: "monotonic",
      },
      { hotkeyEdge: "keydown", timingClock: "monotonic" },
    ];
    for (const overhead of overheads) {
      const sample = overhead === undefined ? {} : { overhead };
      expect([JSON.stringify(overhead), mirror.speedCompatible(sample)]).toEqual([
        JSON.stringify(overhead),
        speedCompatible(sample),
      ]);
    }
  });

  test("pooled speed and pooled accuracy agree on the same samples", async () => {
    const contract = await load();
    const samples: mirror.SampleMeasurementV2[] = [
      leaf("a", { responseMs: 100, audioDurationSec: 1 }),
      leaf("b", { responseMs: 900, audioDurationSec: 9 }),
      leaf("c", { status: "timeout", responseMs: null, audioDurationSec: 30 }),
      leaf("d", { status: "failed", responseMs: null, audioDurationSec: 30 }),
      leaf("e", { responseMs: 500, audioDurationSec: 5, overhead: undefined }),
      leaf("w", { isWarmup: true }),
    ];
    expect(mirror.pooledSpeed(samples)).toEqual(
      (contract.pooledSpeed as typeof mirror.pooledSpeed)(samples),
    );
    expect(mirror.pooledWer(samples)).toEqual(
      (contract.pooledWer as typeof mirror.pooledWer)(samples),
    );
    expect(mirror.pooledCer(samples)).toEqual(
      (contract.pooledCer as typeof mirror.pooledCer)(samples),
    );
    expect(mirror.pooledInferenceRtf(samples)).toEqual(
      (contract.pooledInferenceRtf as typeof mirror.pooledInferenceRtf)(samples),
    );
  });
});

/** Deep equality between two values the type-checker cannot relate. */
function same(actual: unknown, expected: unknown): void {
  expect(actual).toEqual(expected as never);
}

function threw(action: () => unknown): boolean {
  try {
    action();
    return false;
  } catch {
    return true;
  }
}

function leaf(
  clipId: string,
  overrides: Partial<mirror.SampleMeasurementV2> = {},
): mirror.SampleMeasurementV2 {
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
