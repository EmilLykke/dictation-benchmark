import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  measuredPrefix,
  finalizeRunArtifacts,
  sampleClipId,
  sampleMeasurementFor,
  sessionPlaylist,
  type SampleResult,
} from "../src/runner";
import { buildManifest } from "../src/manifest";
import { consumableEntries, planDataset, selectionFor, WARMUP_COUNT } from "../src/selection";
import { runPlanFor } from "../src/v2-plan";
import {
  buildRunRecordV2,
  readRunRecordV2,
  saveRunPlanOnce,
  saveRunRecordV2,
  writeJsonAtomic,
} from "../src/v2-record";
import { collectRecords, parsePublicationArgs } from "../src/publication";
import { SCHEMA_VERSION, uniqueInOrder } from "../src/contract";
import type { DatasetId, ManifestEntry } from "../src/types";

/**
 * Guards for fixes that were correct but unguarded: reverting each one left the whole
 * suite green, which means the fix was resting on nobody touching it.
 *
 * An independent review reverted each in isolation on a byte copy of the repository and
 * confirmed 221/221 still passed, with a no-op control. Every test below is written to
 * go **red** on exactly one of those reverts, and each one names the revert it catches.
 */
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix = "fix-regressions-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

// -- 1. `responseMs` must be the response metric, not the 750 ms-inclusive stable time --

function scored(overrides: Partial<SampleResult> = {}): SampleResult {
  return {
    id: "1272-128104-0000",
    clipId: "librispeech/wav/test-clean/1272-128104-0000.wav",
    warmup: false,
    audioPath: "/root/datasets/librispeech/wav/test-clean/1272-128104-0000.wav",
    audioDurationSec: 2,
    language: "en",
    reference: "THE REFERENCE",
    hypothesis: "the reference",
    status: "ok",
    wer: { wer: 0, substitutions: 0, insertions: 0, deletions: 0, refWords: 2 },
    audioPlaybackMs: 2_100,
    stopToFirstTextMs: 300,
    // 400 ms of response, then the 750 ms confirmation wait, then a poll to notice it.
    stopToLastTextChangeMs: 400,
    stopToStableTextMs: 1_160,
    stabilityDelayMs: 750,
    textChangeSource: "event",
    textChangeCount: 2,
    textChangeBiasMs: 0,
    startToStopMs: 3_100,
    timingClock: "monotonic",
    hotkeyEdge: "keydown",
    ...overrides,
  };
}

describe("1. a v2 sample's responseMs is the last text change, never the stable time", () => {
  test("the 750 ms stability confirmation is not in it", () => {
    // Revert caught: `responseMs: sample.stopToStableTextMs`. That reintroduces the
    // flat 750 ms into every v2 sample of every future run - a handicap presented as a
    // measurement, and applied to Wispr Flow only.
    const measurement = sampleMeasurementFor(scored(), "/root/datasets");

    expect(measurement.responseMs).toBe(400);
    expect(measurement.responseMs).not.toBe(1_160);
    // The stable time survives beside it, under its own name, as overhead.
    expect(measurement.overhead?.stopToStableTextMs).toBe(1_160);
    expect(measurement.overhead?.stabilityDelayMs).toBe(750);
    expect(
      (measurement.overhead!.stopToStableTextMs as number) - measurement.responseMs!,
    ).toBeGreaterThanOrEqual(750);
  });

  test("a pre-2026-09-04 sample falls back, and is excluded from speed for it", () => {
    const legacy = sampleMeasurementFor(
      scored({
        stopToLastTextChangeMs: undefined,
        timingClock: undefined,
        hotkeyEdge: undefined,
      }),
      "/root/datasets",
    );

    expect(legacy.responseMs).toBe(1_160);
    // Readable, and not poolable: no provenance, so `speedCompatible` refuses it.
    expect(legacy.overhead?.hotkeyEdge).toBeUndefined();
    expect(legacy.overhead?.timingClock).toBeUndefined();
    expect(legacy.overhead?.timingRegime).toBe("ui-observed-paste");
  });

  test("provenance is passed through as recorded and never invented", () => {
    const measurement = sampleMeasurementFor(
      scored({ timingClock: undefined, hotkeyEdge: undefined }),
      "/root/datasets",
    );

    expect("hotkeyEdge" in (measurement.overhead ?? {})).toBe(false);
    expect("timingClock" in (measurement.overhead ?? {})).toBe(false);
  });
});

// -- 2. warmups always replay --

describe("2. the completed-ID filter must not swallow the reserved warmups", () => {
  const entries: ManifestEntry[] = Array.from({ length: 8 }, (_unused, index) => ({
    id: `clip-${index}`,
    clipId: `fleurs/da_dk/audio/test/${index}.wav`,
    audioPath: `/tmp/${index}.wav`,
    transcript: "reference",
    language: "da",
    audioDurationSec: 2,
  }));
  const warmups = entries.slice(0, WARMUP_COUNT);
  const clips = entries.slice(WARMUP_COUNT);
  const session = [...warmups, ...clips];

  test("every warmup plays even though no warmup is ever in `remaining`", () => {
    // Revert caught: dropping `warmup ||` from `play`. `remaining` holds *scored*
    // clipIds only - a warmup is on the plan's separate `warmupClipIds` list and is
    // deliberately absent from `orderedClipIds` - so `remaining.has(warmupClipId)` is
    // false for all three. Without the warmup guard the filter swallows every one of
    // them and the model is measured stone cold, with no signal anywhere.
    const remaining = new Set(clips.map((entry) => entry.clipId));
    for (const clipId of remaining) {
      expect(warmups.map((entry) => entry.clipId)).not.toContain(clipId);
    }

    const playlist = sessionPlaylist(session, warmups.length, remaining);
    expect(playlist.filter((slot) => slot.warmup).map((slot) => slot.play)).toEqual([
      true,
      true,
      true,
    ]);
    expect(playlist.filter((slot) => slot.play).length).toBe(session.length);
  });

  test("a fully resumed session still replays all three warmups and no scored clip", () => {
    const playlist = sessionPlaylist(session, warmups.length, new Set());

    expect(playlist.filter((slot) => slot.play).map((slot) => slot.entry.clipId)).toEqual(
      warmups.map((entry) => entry.clipId),
    );
    expect(playlist.filter((slot) => slot.play && !slot.warmup)).toEqual([]);
  });

  test("a half-resumed session replays the warmups and only the outstanding clips", () => {
    const remaining = new Set(clips.slice(2).map((entry) => entry.clipId));
    const playlist = sessionPlaylist(session, warmups.length, remaining);

    expect(playlist.filter((slot) => slot.play).map((slot) => slot.entry.clipId)).toEqual([
      ...warmups.map((entry) => entry.clipId),
      ...clips.slice(2).map((entry) => entry.clipId),
    ]);
  });
});

// -- 3 & 4. dedup and the recorded depth are keyed on clipId, not on the colliding id --

/** A 44-byte silent WAV, so `wavDurationSec` can read a header. */
function silentWav(samples: number): Buffer {
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8_000, 24);
  buffer.writeUInt32LE(16_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

/** A FLEURS locale whose column 0 repeats, exactly as the real one does. */
function collidingFleurs(sentences: number, speakersPerSentence: number): string {
  const root = temporaryRoot("colliding-fleurs-");
  const audioDir = join(root, "fleurs", "da_dk", "audio", "test");
  mkdirSync(audioDir, { recursive: true });
  const rows: string[] = [];
  for (let sentence = 0; sentence < sentences; sentence++) {
    for (let speaker = 0; speaker < speakersPerSentence; speaker++) {
      const fileName = `${sentence}-${speaker}-${"0".repeat(14)}.wav`;
      writeFileSync(join(audioDir, fileName), silentWav(8_000 + sentence));
      rows.push([`${1000 + sentence}`, fileName, `Rå ${sentence}`, `sætning ${sentence}`, "x"].join("\t"));
    }
  }
  writeFileSync(join(root, "fleurs", "da_dk", "test.tsv"), `${rows.join("\n")}\n`);
  return root;
}

describe("3 & 4. defect 1's two fix sites, driven through the manifest builder", () => {
  const datasetsDir = collidingFleurs(40, 3);
  const entries = buildManifest(datasetsDir, "da_dk" as DatasetId);

  test("the synthetic corpus really does collide on the legacy id", () => {
    // Otherwise the two tests below would pass under the reverts as well.
    expect(entries).toHaveLength(120);
    expect(uniqueInOrder(entries.map((entry) => entry.clipId))).toHaveLength(120);
    expect(uniqueInOrder(entries.map((entry) => entry.id))).toHaveLength(40);
  });

  test("the already-captured set is keyed so it holds one entry per audio file", () => {
    // Revert caught: `new Set(result.samples.map((sample) => sample.id))`. On this
    // corpus that set holds 40 values for 120 clips, so two thirds of a range read as
    // already captured and were never played.
    const samples = entries.map<SampleResult>((entry) => ({
      ...scored(),
      id: entry.id,
      clipId: entry.clipId,
      audioPath: entry.audioPath,
    }));
    const captured = new Set(samples.map((sample) => sampleClipId(sample, datasetsDir)));

    expect(captured.size).toBe(120);
    expect(captured.size).not.toBe(40);
    for (const entry of entries) expect(captured.has(entry.clipId)).toBe(true);
  });

  test("the recorded depth counts clips transcribed, not sentences touched", () => {
    // Revert caught: `measuredPrefix` back to `.id`. That is the field that writes the
    // recorded `endIndex`, so on this corpus a range would claim a depth roughly three
    // times what was measured.
    const plan = planDataset("da_dk", entries, 0, { kind: "target", to: 60 });
    expect(plan.clips).toHaveLength(60);

    // Exactly the first 12 clips are captured, by clipId, as production does it.
    const captured = new Set(plan.clips.slice(0, 12).map((entry) => entry.clipId));
    expect(measuredPrefix(plan, captured)).toBe(12);

    const selection = selectionFor(plan, measuredPrefix(plan, captured));
    expect(selection.endIndex).toBe(12);
    expect(selection.contiguousEndIndex).toBe(12);

    // The clips just past the prefix share sentence ids with clips inside it, so a
    // prefix counted on `id` would have run straight past them for free.
    const insideIds = new Set(plan.clips.slice(0, 12).map((entry) => entry.id));
    expect(plan.clips.slice(12, 24).some((entry) => insideIds.has(entry.id))).toBe(true);
  });

  test("a plan over this corpus names as many distinct clips as it has slots", () => {
    const plan = planDataset("da_dk", entries, 0, { kind: "target", to: 60 });

    expect(new Set(plan.clips.map((entry) => entry.clipId)).size).toBe(60);
    expect(new Set(plan.clips.map((entry) => entry.id)).size).toBeLessThan(60);
  });
});

// -- 5. the schema-version alias is normalised before the guard --

describe("5. normalizeRunRecordV2 sits in front of every v2 read", () => {
  test("a record keyed with the constant's name is read, not silently dropped", () => {
    // Revert caught: removing `normalizeRunRecordV2` from `readRunRecordV2`. Such a
    // record is legible to a human and invisible to the guard, which is the dangerous
    // combination - it vanishes from pooling while still sitting on disk, and nothing
    // logs.
    const root = temporaryRoot();
    const plan = runPlanFor({
      runId: "aliased-run",
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: Array.from({ length: 6 }, (_unused, index) => ({
        id: `c${index}`,
        clipId: `fleurs/da_dk/audio/test/${index}.wav`,
        audioPath: `/tmp/${index}.wav`,
        transcript: "r",
        language: "da",
        audioDurationSec: 2,
      })),
      fromIndex: 0,
      toIndex: 3,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const record = buildRunRecordV2({
      plan,
      status: "completed",
      startedAt: "2026-09-04T00:00:00.000Z",
      completedAt: "2026-09-04T01:00:00.000Z",
      samples: plan.orderedClipIds.map((clipId) => ({
        clipId, audioDurationSec: 2, responseMs: 400, status: "ok" as const,
        wordErrors: 0, referenceWords: 1, charErrors: 0, referenceChars: 1, isWarmup: false,
      })),
    });

    const { schemaVersion, ...rest } = record as unknown as Record<string, unknown>;
    const path = join(root, "aliased.json");
    writeJsonAtomic(path, { SCHEMA_VERSION: schemaVersion, ...rest });

    const read = readRunRecordV2(path);
    expect(read).not.toBeNull();
    expect(read!.schemaVersion).toBe(SCHEMA_VERSION);
    expect("SCHEMA_VERSION" in (read as unknown as Record<string, unknown>)).toBe(false);
  });

  test("a structurally-v2 semantic contradiction throws instead of disappearing", () => {
    const root = temporaryRoot();
    const entries: ManifestEntry[] = Array.from({ length: 4 }, (_unused, index) => ({
      id: `c${index}`, clipId: `fleurs/da_dk/audio/test/${index}.wav`,
      audioPath: `/tmp/${index}.wav`, transcript: "r", language: "da", audioDurationSec: 2,
    }));
    const plan = runPlanFor({ runId: "contradiction", harness: "wispr-flow", model: "wispr-flow",
      dataset: "da_dk", entries, fromIndex: 0, toIndex: 1, createdAt: "2026-09-04T00:00:00Z" });
    const record = buildRunRecordV2({
      plan, status: "completed", startedAt: "2026-09-04T00:00:00Z",
      completedAt: "2026-09-04T00:01:00Z",
      samples: plan.orderedClipIds.map((clipId) => ({
        clipId, audioDurationSec: 2, responseMs: 400, status: "ok" as const,
        wordErrors: 0, referenceWords: 1, charErrors: 0, referenceChars: 1, isWarmup: false,
      })),
    });
    const path = join(root, "record.json");
    writeJsonAtomic(path, { ...record, datasetId: "fleurs/hu_hu" });

    expect(() => readRunRecordV2(path)).toThrow(/says dataset fleurs\/hu_hu/);
  });
});

// -- 6. a Run Plan is immutable --

describe("6. saveRunPlanOnce refuses a different plan under the same name", () => {
  const entries: ManifestEntry[] = Array.from({ length: 20 }, (_unused, index) => ({
    id: `c${index}`,
    clipId: `fleurs/da_dk/audio/test/${index}.wav`,
    audioPath: `/tmp/${index}.wav`,
    transcript: "r",
    language: "da",
    audioDurationSec: 2,
  }));

  function plan(toIndex: number) {
    return runPlanFor({
      runId: "run-1",
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries,
      fromIndex: 0,
      toIndex,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
  }

  test("an identical re-write is a no-op and a different one throws", () => {
    // Revert caught: letting the second write win. The numbers already recorded against
    // a plan belong to its clips; a plan that can be rewritten lets a second invocation
    // of `--samples 400` mean "another 400 clips" under the first 400's fingerprint.
    const runDir = temporaryRoot();

    const first = saveRunPlanOnce(runDir, "da_dk", plan(5));
    expect(first.fingerprintV2.value).toBe(plan(5).fingerprintV2.value);
    // Same plan again: accepted, so re-running the same command is safe.
    expect(saveRunPlanOnce(runDir, "da_dk", plan(5)).fingerprintV2.value).toBe(
      first.fingerprintV2.value,
    );

    expect(() => saveRunPlanOnce(runDir, "da_dk", plan(9))).toThrow(
      /already exists with fingerprint .*A Run Plan is immutable/s,
    );
    // And the file on disk still describes the original selection.
    expect(saveRunPlanOnce(runDir, "da_dk", plan(5)).orderedClipIds).toHaveLength(5);
  });
});

// -- 7. a production batch never reads smoke records --

describe("7. collectRecords excludes smoke output from a production batch", () => {
  test("a smoke record in the tree is invisible to a production read", () => {
    // Revert caught: `includeSmoke: true` unconditionally. Five rehearsal clips per
    // dataset would then complete production stages and advance a published depth.
    const root = temporaryRoot();
    const production = parsePublicationArgs([
      "--batch",
      "prod-1",
      "--to",
      "5",
      "--out",
      root,
      "--codictate",
      join(root, "codictate"),
    ]);
    const smoke = parsePublicationArgs([
      "--batch",
      "prod-1",
      "--smoke",
      "--clips-per-dataset",
      "5",
      "--out",
      root,
      "--codictate",
      join(root, "codictate"),
    ]);

    const plan = runPlanFor({
      runId: "rehearsal",
      batchId: "prod-1",
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: Array.from({ length: 10 }, (_unused, index) => ({
        id: `c${index}`,
        clipId: `fleurs/da_dk/audio/test/${index}.wav`,
        audioPath: `/tmp/${index}.wav`,
        transcript: "r",
        language: "da",
        audioDurationSec: 2,
      })),
      fromIndex: 0,
      toIndex: 5,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const record = buildRunRecordV2({
      plan,
      status: "completed",
      startedAt: "2026-09-04T00:00:00.000Z",
      completedAt: "2026-09-04T01:00:00.000Z",
      samples: plan.orderedClipIds.map((clipId) => ({
        clipId,
        audioDurationSec: 2,
        responseMs: 400,
        status: "ok" as const,
        wordErrors: 0,
        referenceWords: 4,
        charErrors: 0,
        referenceChars: 20,
        isWarmup: false,
      })),
    });

    saveRunRecordV2(join(root, "smoke", "prod-1", "20260904_000000_rehearsal"), "da_dk", record);

    expect(collectRecords(production)).toEqual([]);
    // The smoke chain reads its own tree, which is why the opt-in exists at all.
    expect(collectRecords(smoke).length).toBeGreaterThan(0);
  });
});

describe("8. v1-completed/v2-incomplete finalization crash is recoverable", () => {
  test("resume finalization promotes v2 before rewriting the completed v1 marker", () => {
    const runDir = temporaryRoot("finalize-repair-");
    const entries: ManifestEntry[] = Array.from({ length: 5 }, (_unused, index) => ({
      id: `c${index}`,
      clipId: `fleurs/da_dk/audio/test/${index}.wav`,
      audioPath: `/datasets/fleurs/da_dk/audio/test/${index}.wav`,
      transcript: "reference",
      language: "da",
      audioDurationSec: 2,
    }));
    const datasetPlan = planDataset("da_dk", entries, 0, { kind: "target", to: 1 });
    const plan = runPlanFor({
      runId: "flow-crashed-finalizing", batchId: "batch-1", harness: "wispr-flow",
      model: "wispr-flow", dataset: "da_dk", entries, fromIndex: 0, toIndex: 1,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    saveRunPlanOnce(runDir, "da_dk", plan);
    const sample = scored({
      id: entries[WARMUP_COUNT].id,
      clipId: entries[WARMUP_COUNT].clipId,
      audioPath: entries[WARMUP_COUNT].audioPath,
      audioDurationSec: entries[WARMUP_COUNT].audioDurationSec,
      language: "da",
      reference: "reference",
    });
    const run = {
      schemaVersion: 1 as const,
      status: "completed" as const,
      runId: plan.runId,
      createdAt: plan.createdAt,
      completedAt: "2026-09-04T01:00:00.000Z",
      updatedAt: "2026-09-04T01:00:00.000Z",
      product: { id: "wispr-flow", label: "Wispr Flow", version: "1" },
      hardware: { platform: "darwin", release: "1", arch: "arm64", cpu: "test" },
      config: {
        codictatePath: "/codictate", datasets: ["da_dk" as DatasetId], to: 1,
        deviceName: "BlackHole 2ch", hotkey: { keyCode: 6, modifiers: ["option" as const] },
        leadMs: 100, tailMs: 100, timeoutMs: 1_000, batchId: "batch-1", stableMs: 750,
        pollIntervalMs: 10, configurationNote: "test",
      },
      results: { da_dk: { samples: [sample], selection: selectionFor(datasetPlan, 1) } },
    };
    saveRunRecordV2(runDir, "da_dk", buildRunRecordV2({
      plan, status: "incomplete", startedAt: plan.createdAt, completedAt: null,
      samples: [sampleMeasurementFor(sample, "/datasets")],
    }));

    finalizeRunArtifacts(
      runDir,
      run,
      [datasetPlan],
      new Map([["da_dk" as DatasetId, entries]]),
      "/datasets",
    );

    expect(readRunRecordV2(join(runDir, "v2", "da_dk.json"))!.status).toBe("completed");
    expect(JSON.parse(readFileSync(join(runDir, "results.json"), "utf8")).status).toBe("completed");
    expect(Bun.file(join(runDir, "stt.json")).size).toBeGreaterThan(0);
  });
});
