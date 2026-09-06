import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  batchDir,
  CODICTATE_MODELS,
  DANISH_ONLY_MODELS,
  DEFAULT_FLOW_HOTKEY,
  MULTILINGUAL_MODELS,
  SMOKE_MODELS,
  loadOrCreateBatchManifest,
  manifestPath,
  parsePublicationArgs,
  codictateResultsRoot,
  manualResumeCommand,
  runIdForStage,
  shellQuote,
  stageCommand,
  stageDecision,
  stageIdOf,
  stageMatrix,
  assertStageCompletedAfterExit,
  type PublicationOptions,
} from "../src/publication";
import { parseHotkey } from "../src/publication-hotkey";
import {
  buildRunRecordV2,
  isSmokePath,
  readRunPlan,
  saveRunRecordV2,
  scanRunRecordsV2,
  v2CursorFor,
  writeJsonAtomic,
} from "../src/v2-record";
import { runPlanFor } from "../src/v2-plan";
import { WARMUP_COUNT } from "../src/selection";
import { DATASET_IDS, type DatasetId, type ManifestEntry } from "../src/types";
import { fingerprintV2 } from "../src/contract";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix = "publication-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

/** A synthetic manifest per dataset, so nothing here needs the real corpus. */
function manifests(count = 40): Map<DatasetId, ManifestEntry[]> {
  const map = new Map<DatasetId, ManifestEntry[]>();
  for (const dataset of DATASET_IDS) {
    const prefix = dataset.startsWith("test-")
      ? `librispeech/wav/${dataset}`
      : `fleurs/${dataset}/audio/test`;
    map.set(
      dataset,
      Array.from({ length: count }, (_unused, index) => ({
        id: `${dataset}-${index}`,
        clipId: `${prefix}/${index}.wav`,
        audioPath: `/tmp/${dataset}-${index}.wav`,
        transcript: "reference",
        language: dataset.startsWith("test-") ? "en" : dataset.split("_")[0],
        audioDurationSec: 2,
      })),
    );
  }
  return map;
}

function options(overrides: Partial<PublicationOptions> = {}): PublicationOptions {
  const root = overrides.resultsRoot ?? temporaryRoot();
  return {
    batchId: "2026-09-v2",
    fromIndex: 0,
    toIndex: 10,
    flowHotkey: parseHotkey("option+z"),
    smoke: false,
    resultsRoot: root,
    batchRoot: join(root, "batches"),
    // Two models by default, so the stage-level tests below stay about the behaviour
    // under test rather than about 19 stages. `describe("the production matrix")` is
    // where the full 18-model shape is asserted.
    models: [...SMOKE_MODELS],
    datasets: [...DATASET_IDS],
    dryRun: false,
    downloadOnly: false,
    preflightOnly: false,
    codictatePath: "/tmp/codictate",
    deviceName: "BlackHole 2ch",
    ...overrides,
  };
}

describe("flag parsing", () => {
  test("--batch is required and names the immutable shared manifest", () => {
    expect(() => parsePublicationArgs([])).toThrow(/--batch <id> is required/);
    expect(() => parsePublicationArgs(["--batch", "../escape"])).toThrow(
      /must be a directory-safe name/,
    );
  });

  test("the documented production invocation parses to the documented range", () => {
    const parsed = parsePublicationArgs([
      "--batch",
      "2026-09-v2",
      "--from",
      "0",
      "--to",
      "400",
      "--flow-hotkey",
      "option+z",
    ]);

    expect(parsed).toMatchObject({
      batchId: "2026-09-v2",
      fromIndex: 0,
      toIndex: 400,
      smoke: false,
      datasets: ["test-clean", "test-other", "es_419", "da_dk", "hu_hu"],
    });
    // A production batch defaults to the whole 18-model matrix.
    expect(parsed.models).toEqual([...CODICTATE_MODELS]);
    expect(parsed.models).toHaveLength(18);
    expect(parsed.flowHotkey).toEqual({ keyCode: 6, modifiers: ["option"], spec: "option+z" });
  });

  test("--smoke rehearses two models, not the production matrix", () => {
    // SPEC §8. The smoke chain exists to prove the chain works; 30,000 clips is not a
    // rehearsal, and a rehearsal that took a night would not get run.
    expect(parsePublicationArgs(["--batch", "s", "--smoke"]).models).toEqual([
      "large-v3-q5_0",
      "hviske-v5-tiny-q5_0",
    ]);
    // An explicit --models still wins over both defaults.
    expect(
      parsePublicationArgs(["--batch", "s", "--smoke", "--models", "medium"]).models,
    ).toEqual(["medium"]);
  });

  test("--smoke defaults to five clips per dataset and its own git-ignored tree", () => {
    const parsed = parsePublicationArgs(["--batch", "smoke-1", "--smoke"]);

    expect(parsed.smoke).toBe(true);
    expect(parsed.clipsPerDataset).toBe(5);
    expect(parsed.fromIndex).toBe(0);
    expect(parsed.toIndex).toBe(5);
    // The exclusion is a property of where the run is, not of a flag a reader has to
    // remember to pass.
    expect(parsed.resultsRoot.endsWith(join("results", "smoke", "smoke-1"))).toBe(true);
    expect(isSmokePath(relative(resolve(import.meta.dir, "../results"), parsed.resultsRoot))).toBe(
      true,
    );
  });

  test("a production batch writes its metadata outside the flat run list", () => {
    const parsed = parsePublicationArgs(["--batch", "2026-09-v2"]);

    // `results/` is a flat list of run directories; batch metadata among them would
    // look like a run to the v1 cursor scan.
    expect(parsed.resultsRoot.endsWith("results")).toBe(true);
    expect(batchDir(parsed).endsWith(join("results", "batches", "2026-09-v2"))).toBe(true);
  });

  test("--clips-per-dataset and a disagreeing --to are refused rather than reconciled", () => {
    expect(() =>
      parsePublicationArgs(["--batch", "b", "--clips-per-dataset", "5", "--to", "400"]),
    ).toThrow(/describe different ranges \(400 vs 5\)/);
    // Agreeing values are fine.
    expect(
      parsePublicationArgs(["--batch", "b", "--clips-per-dataset", "5", "--to", "5"]).toIndex,
    ).toBe(5);
  });

  test("an empty range is refused", () => {
    expect(() => parsePublicationArgs(["--batch", "b", "--from", "400", "--to", "400"])).toThrow(
      /selects no clips/,
    );
  });

  test("unknown datasets and unknown flags are named", () => {
    expect(() => parsePublicationArgs(["--batch", "b", "--datasets", "de_de"])).toThrow(
      /Unknown dataset "de_de"/,
    );
    expect(() => parsePublicationArgs(["--batch", "b", "--publish"])).toThrow(
      /Unknown flag: --publish/,
    );
  });

  test("the hotkey default is SPEC §5's Option+Z, and a bad one fails at parse time", () => {
    expect(DEFAULT_FLOW_HOTKEY).toBe("option+z");
    expect(parseHotkey("option+space")).toEqual({
      keyCode: 49,
      modifiers: ["option"],
      spec: "option+space",
    });
    expect(() => parseHotkey("z")).toThrow(/at least one modifier and a key/);
    expect(() => parseHotkey("option+q")).toThrow(/unknown key "q"/);
    expect(() => parseHotkey("meta+z")).toThrow(/unknown modifier "meta"/);
  });

  test("alt+z and opt+z are the same shortcut as option+z", () => {
    // What the key is labelled on the keyboard, and what most other tools call it.
    // Normalised, so the recorded value is one thing.
    for (const spec of ["alt+z", "opt+z", "option+z"]) {
      expect([spec, parseHotkey(spec).keyCode]).toEqual([spec, 6]);
      expect([spec, parseHotkey(spec).modifiers]).toEqual([spec, ["option"]]);
    }
    expect(parseHotkey("cmd+shift+z").modifiers).toEqual(["command", "shift"]);
    // And the spec the operator typed is echoed back, so the preview is checkable.
    expect(parseHotkey("alt+z").spec).toBe("alt+z");
  });

  test("F8: the manifest is immutable against the hotkey and the audio device too", () => {
    // Neither can be verified from this side, so a silent change is undetectable
    // afterwards: the preview printed the manifest's hotkey while the run used the new
    // one, and the record then disagreed with the manifest about it.
    const root = temporaryRoot("f8-");
    const base = { resultsRoot: root, batchRoot: join(root, "batches") };
    const map = manifests();
    loadOrCreateBatchManifest(options(base), map, "2026-09-04T00:00:00.000Z");

    expect(() =>
      loadOrCreateBatchManifest(
        options({ ...base, flowHotkey: parseHotkey("option+space") }),
        map,
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow(/flowHotkey option\+z vs option\+space/);

    expect(() =>
      loadOrCreateBatchManifest(
        options({ ...base, deviceName: "Loopback 2ch" }),
        map,
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow(/deviceName BlackHole 2ch vs Loopback 2ch/);
  });

  test("F8: NARROWING a batch is refused, not silently discarded", () => {
    // `--datasets da_dk` against a five-dataset manifest used to run all five: the four
    // extra stages existed only in the manifest, and the comparison iterated the fresh
    // stages only. A plan the operator typed and did not get is worse than an error.
    const root = temporaryRoot("f8-narrow-");
    const base = { resultsRoot: root, batchRoot: join(root, "batches") };
    const map = manifests();
    loadOrCreateBatchManifest(options(base), map, "2026-09-04T00:00:00.000Z");

    expect(() =>
      loadOrCreateBatchManifest(
        options({ ...base, datasets: ["da_dk"] }),
        map,
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow(/is in the manifest but not in this invocation/);

    expect(() =>
      loadOrCreateBatchManifest(
        options({ ...base, models: ["large-v3-q5_0"] }),
        map,
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow(/stage codictate-hviske-v5-tiny-q5_0 is in the manifest but not in this invocation/);

    // Widening was already caught, and still is.
    expect(() =>
      loadOrCreateBatchManifest(
        options({ ...base, models: [...SMOKE_MODELS, "medium-q5_0"] }),
        map,
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow(/is new in this invocation/);
  });
});

describe("the production matrix", () => {
  test("runs Wispr Flow first, then the Codictate models in order", () => {
    const stages = stageMatrix(options(), manifests(), "2026-09-04T00:00:00.000Z");

    expect(stages.map((stage) => [stage.order, stage.harness, stage.model])).toEqual([
      [0, "wispr-flow", "wispr-flow"],
      [1, "codictate", "large-v3-q5_0"],
      [2, "codictate", "hviske-v5-tiny-q5_0"],
    ]);
  });

  test("the full production matrix is 19 stages and 30,000 scored clips at 400", () => {
    const stages = stageMatrix(
      options({ models: [...CODICTATE_MODELS], toIndex: 400 }),
      manifests(500),
      "2026-09-04T00:00:00.000Z",
    );

    expect(stages).toHaveLength(19);
    // Wispr Flow first, then the thirteen multilingual models, then the five Danish ones.
    expect(stages[0]).toMatchObject({ harness: "wispr-flow", model: "wispr-flow" });
    expect(stages.slice(1).map((stage) => stage.model)).toEqual([...CODICTATE_MODELS]);
    expect(stages.every((stage, index) => stage.order === index)).toBe(true);

    const scored = stages.reduce(
      (total, stage) => total + stage.plans.reduce((sum, plan) => sum + plan.clipCount, 0),
      0,
    );
    // Flow 5x400 + 13 multilingual x 5x400 + 5 Danish-only x 400.
    expect(scored).toBe(400 * 5 + MULTILINGUAL_MODELS.length * 5 * 400 + DANISH_ONLY_MODELS.length * 400);
    expect(scored).toBe(30_000);
  });

  test("every Danish-pinned model is measured on Danish alone", () => {
    const stages = stageMatrix(
      options({ models: [...CODICTATE_MODELS] }),
      manifests(),
      "2026-09-04T00:00:00.000Z",
    );

    for (const model of DANISH_ONLY_MODELS) {
      const stage = stages.find((entry) => entry.model === model)!;
      expect([model, stage.plans.map((plan) => plan.dataset)]).toEqual([model, ["da_dk"]]);
    }
    for (const model of MULTILINGUAL_MODELS) {
      const stage = stages.find((entry) => entry.model === model)!;
      expect([model, stage.plans.length]).toEqual([model, 5]);
    }
  });

  test("Wispr Flow and large-v3-q5_0 cover all five dataset buckets", () => {
    const stages = stageMatrix(options(), manifests(), "2026-09-04T00:00:00.000Z");

    for (const stageId of ["wispr-flow", "codictate-large-v3-q5_0"]) {
      const stage = stages.find((entry) => entry.stageId === stageId)!;
      expect(stage.plans.map((plan) => plan.datasetId)).toEqual([
        "librispeech/test-clean",
        "librispeech/test-other",
        "fleurs/es_419",
        "fleurs/da_dk",
        "fleurs/hu_hu",
      ]);
    }
  });

  test("the Danish-pinned model is measured on Danish alone", () => {
    // hviske transcribes as Danish whatever it is handed, so an English split would
    // measure Danish decoding of English speech rather than the model.
    const stage = stageMatrix(options(), manifests(), "2026-09-04T00:00:00.000Z").find(
      (entry) => entry.model === "hviske-v5-tiny-q5_0",
    )!;

    expect(stage.plans.map((plan) => plan.dataset)).toEqual(["da_dk"]);
  });

  test("every stage's plan is fingerprinted over its scored clips, warmups excluded", () => {
    const map = manifests();
    const stages = stageMatrix(options(), map, "2026-09-04T00:00:00.000Z");
    const plan = stages[0].plans.find((entry) => entry.dataset === "da_dk")!;
    const consumable = map.get("da_dk")!.slice(WARMUP_COUNT);

    expect(plan.clipCount).toBe(10);
    expect(plan.warmupCount).toBe(WARMUP_COUNT);
    expect(plan.fingerprintV2).toEqual({
      version: "benchmark-v2",
      value: fingerprintV2(consumable.slice(0, 10).map((entry) => entry.clipId)),
    });
  });

  test("both products fingerprint the same clips, which is what makes them comparable", () => {
    const stages = stageMatrix(options(), manifests(), "2026-09-04T00:00:00.000Z");
    const flow = stages[0].plans.find((plan) => plan.dataset === "da_dk")!;
    const codictate = stages[1].plans.find((plan) => plan.dataset === "da_dk")!;

    expect(flow.fingerprintV2.value).toBe(codictate.fingerprintV2.value);
  });

  test("--models and --datasets narrow the matrix", () => {
    const narrowed = stageMatrix(
      options({ models: ["large-v3-q5_0"], datasets: ["da_dk", "hu_hu"] }),
      manifests(),
      "2026-09-04T00:00:00.000Z",
    );

    expect(narrowed.map((stage) => stage.stageId)).toEqual([
      "wispr-flow",
      "codictate-large-v3-q5_0",
    ]);
    expect(narrowed[0].plans.map((plan) => plan.dataset)).toEqual(["da_dk", "hu_hu"]);
  });

  test("a range past the end of a dataset is shortened, not refused", () => {
    // A dataset with 300 clips left under --to 400 is complete at 300; refusing the
    // whole batch for that would abort a night that could still measure the rest.
    const stages = stageMatrix(
      options({ toIndex: 100 }),
      manifests(20),
      "2026-09-04T00:00:00.000Z",
    );

    expect(stages[0].plans.every((plan) => plan.toIndex === 20 - WARMUP_COUNT)).toBe(true);
  });

  test("--from past the end of a dataset is refused, naming the count", () => {
    expect(() =>
      stageMatrix(options({ fromIndex: 500, toIndex: 505 }), manifests(20), "2026-09-04T00:00:00.000Z"),
    ).toThrow(/--from 500 is past the end of test-clean, which has 17 consumable clips/);
  });
});

describe("the immutable shared batch manifest", () => {
  test("is written once and re-read rather than rebuilt", () => {
    const opts = options();
    const map = manifests();
    const first = loadOrCreateBatchManifest(opts, map, "2026-09-04T00:00:00.000Z");
    const second = loadOrCreateBatchManifest(opts, map, "2026-09-05T00:00:00.000Z");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    // The second invocation's range comes from the file, not from today's clock.
    expect(second.manifest.createdAt).toBe("2026-09-04T00:00:00.000Z");
    expect(existsSync(manifestPath(opts))).toBe(true);
  });

  test("carries the instrumentation asymmetry sentence verbatim", () => {
    const { manifest } = loadOrCreateBatchManifest(
      options(),
      manifests(),
      "2026-09-04T00:00:00.000Z",
    );

    expect(manifest.instrumentationNote).toBe(
      "Response times are not measured the same way for both products: Codictate is timed at " +
        "the direct adapter call boundary, Wispr Flow is timed from the UI-observed paste.",
    );
  });

  test("refuses a second invocation that describes a different batch, naming what moved", () => {
    const root = temporaryRoot();
    const map = manifests();
    loadOrCreateBatchManifest(options({ resultsRoot: root, batchRoot: join(root, "batches") }), map, "2026-09-04T00:00:00.000Z");

    expect(() =>
      loadOrCreateBatchManifest(
        options({ resultsRoot: root, batchRoot: join(root, "batches"), toIndex: 20 }),
        map,
        "2026-09-04T00:00:00.000Z",
      ),
    ).toThrow(/range \[0, 10\) vs \[0, 20\)/);
  });

  test("refuses a corpus that has moved under an existing batch", () => {
    const root = temporaryRoot();
    const opts = options({ resultsRoot: root, batchRoot: join(root, "batches") });
    loadOrCreateBatchManifest(opts, manifests(), "2026-09-04T00:00:00.000Z");

    // A different clip order is a different sample. The second half of a comparison
    // must not be filed against it.
    const reordered = manifests();
    reordered.set("da_dk", [...reordered.get("da_dk")!].reverse());

    expect(() =>
      loadOrCreateBatchManifest(opts, reordered, "2026-09-04T00:00:00.000Z"),
    ).toThrow(/wispr-flow\/da_dk fingerprint/);
  });

  test("writes one immutable Run Plan file per stage per dataset", () => {
    const opts = options();
    loadOrCreateBatchManifest(opts, manifests(), "2026-09-04T00:00:00.000Z");

    const planDir = join(batchDir(opts), "plans");
    expect(readdirSync(planDir).sort()).toEqual([
      "codictate-hviske-v5-tiny-q5_0",
      "codictate-large-v3-q5_0",
      "wispr-flow",
    ]);
    expect(readdirSync(join(planDir, "wispr-flow")).sort()).toEqual([
      "da_dk.json",
      "es_419.json",
      "hu_hu.json",
      "test-clean.json",
      "test-other.json",
    ]);
    expect(readdirSync(join(planDir, "codictate-hviske-v5-tiny-q5_0"))).toEqual(["da_dk.json"]);
  });

  test("recovers an exact missing plan before trusting an existing manifest", () => {
    const opts = options();
    const map = manifests();
    loadOrCreateBatchManifest(opts, map, "2026-09-04T00:00:00.000Z");
    const missing = join(batchDir(opts), "plans", "wispr-flow", "da_dk.json");
    const expected = readFileSync(missing, "utf8");
    unlinkSync(missing);

    loadOrCreateBatchManifest(opts, map, "2026-09-05T00:00:00.000Z");
    expect(readFileSync(missing, "utf8")).toBe(expected);
  });

  test("fails closed when an existing plan is malformed", () => {
    const opts = options();
    const map = manifests();
    loadOrCreateBatchManifest(opts, map, "2026-09-04T00:00:00.000Z");
    const path = join(batchDir(opts), "plans", "wispr-flow", "da_dk.json");
    writeFileSync(path, "{ truncated");

    expect(() => loadOrCreateBatchManifest(opts, map, "2026-09-05T00:00:00.000Z")).toThrow(
      /malformed JSON/,
    );
  });

  test("recovers a crash after first plan but before manifest with one creation timestamp", () => {
    const opts = options({ datasets: ["da_dk"], models: ["large-v3-q5_0"] });
    const map = manifests();
    const oldCreatedAt = "2026-09-04T00:00:00.000Z";
    const stage = stageMatrix(opts, map, oldCreatedAt)[0];
    const path = join(batchDir(opts), "plans", stage.stageId, "da_dk.json");
    mkdirSync(join(batchDir(opts), "plans", stage.stageId), { recursive: true });
    writeJsonAtomic(path, runPlanFor({
      runId: `${opts.batchId}_${stage.stageId}_da_dk`, batchId: opts.batchId,
      harness: stage.harness, model: stage.model, dataset: "da_dk", entries: map.get("da_dk")!,
      fromIndex: 0, toIndex: 10, createdAt: oldCreatedAt,
    }));

    const recovered = loadOrCreateBatchManifest(opts, map, "2026-09-05T00:00:00.000Z");
    expect(recovered.manifest.createdAt).toBe(oldCreatedAt);
    expect(readRunPlan(path)!.createdAt).toBe(oldCreatedAt);
  });
});

describe("stage decisions", () => {
  function seeded(): { opts: PublicationOptions; map: Map<DatasetId, ManifestEntry[]> } {
    const root = temporaryRoot();
    const opts = options({
      resultsRoot: root,
      batchRoot: join(root, "batches"),
      datasets: ["da_dk"],
      models: ["large-v3-q5_0"],
    });
    const map = manifests();
    loadOrCreateBatchManifest(opts, map, "2026-09-04T00:00:00.000Z");
    return { opts, map };
  }

  test("an untouched stage is RUN", () => {
    const { opts, map } = seeded();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const decision = stageDecision(opts, stages[0], []);

    expect(decision.decision).toBe("run");
    expect(decision.state.progress?.da_dk).toEqual({
      cursor: 0,
      maxMeasuredEnd: 0,
      clipCount: 10,
    });
  });

  test("a fully measured stage is SKIPPED, and an incomplete run is RESUMED", () => {
    const { opts, map } = seeded();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const plan = runPlanFor({
      runId: "run-1",
      batchId: opts.batchId,
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: map.get("da_dk")!,
      fromIndex: 0,
      toIndex: 10,
      createdAt: "2026-09-04T00:00:00.000Z",
    });

    const partial = recordFor(plan, "run-1", "incomplete", plan.orderedClipIds.slice(0, 4));
    expect(stageDecision(opts, stages[0], [partial]).decision).toBe("resume");
    // Incomplete records are resume sources only; they never advance published progress.
    expect(stageDecision(opts, stages[0], [partial]).state.progress?.da_dk.cursor).toBe(0);

    const whole = recordFor(plan, "run-1", "completed", plan.orderedClipIds);
    expect(stageDecision(opts, stages[0], [whole]).decision).toBe("skip-completed");
    expect(stageDecision(opts, stages[0], [whole]).state.status).toBe("completed");
  });

  test("an incomplete record never completes a stage, whatever it measured", () => {
    // Defect 3. An unfinished run has not been checked against its plan.
    const { opts, map } = seeded();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const plan = runPlanFor({
      runId: "run-1",
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: map.get("da_dk")!,
      fromIndex: 0,
      toIndex: 10,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const record = recordFor(plan, "run-1", "incomplete", plan.orderedClipIds);

    const decision = stageDecision(opts, stages[0], [record]);
    expect(decision.decision).not.toBe("skip-completed");
    expect(decision.state.progress?.da_dk.cursor).toBe(0);
  });

  test("a completed record with a gap is rejected before it can affect a stage", () => {
    const { opts, map } = seeded();
    const plan = runPlanFor({
      runId: "run-1",
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: map.get("da_dk")!,
      fromIndex: 0,
      toIndex: 10,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const holed = [...plan.orderedClipIds.slice(0, 3), ...plan.orderedClipIds.slice(7)];
    expect(() => recordFor(plan, "run-1", "completed", holed)).toThrow(
      /completed but has 6 scored Samples/,
    );
  });

  test("a record for another plan says nothing about this stage", () => {
    const { opts, map } = seeded();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const otherPlan = runPlanFor({
      runId: "run-elsewhere",
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: map.get("da_dk")!,
      fromIndex: 20,
      toIndex: 30,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const record = recordFor(otherPlan, "run-elsewhere", "completed", otherPlan.orderedClipIds);

    expect(stageDecision(opts, stages[0], [record]).state.progress?.da_dk.cursor).toBe(0);
  });

  test("the run id a stage is resumed by comes off the records, matched on the batch", () => {
    const { opts, map } = seeded();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const mine = runPlanFor({
      runId: "run-mine",
      batchId: opts.batchId,
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: map.get("da_dk")!,
      fromIndex: 0,
      toIndex: 10,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const theirs = runPlanFor({
      runId: "run-theirs",
      batchId: "another-batch",
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: map.get("da_dk")!,
      fromIndex: 0,
      toIndex: 10,
      createdAt: "2026-09-04T00:00:00.000Z",
    });

    const records = [
      recordFor(theirs, "run-theirs", "completed", theirs.orderedClipIds),
      recordFor(mine, "run-mine", "incomplete", mine.orderedClipIds.slice(0, 2)),
    ];
    expect(runIdForStage(stages[0], records, opts.batchId)).toBe("run-mine");
    expect(runIdForStage(stages[0], records, "no-such-batch")).toBeUndefined();
  });

  test("an incomplete current-batch record is RESUME even before stage state captures its id", () => {
    const { opts, map } = seeded();
    const stage = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z")[0];
    const plan = runPlanFor({
      runId: "interrupted-flow",
      batchId: opts.batchId,
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: map.get("da_dk")!,
      fromIndex: 0,
      toIndex: 10,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const outcome = stageDecision(opts, stage, [recordFor(plan, plan.runId, "incomplete", [])]);

    expect(outcome.decision).toBe("resume");
    expect(outcome.state.runId).toBe("interrupted-flow");
  });
});

function recordFor(
  plan: ReturnType<typeof runPlanFor>,
  runId: string,
  status: "completed" | "incomplete",
  clipIds: readonly string[],
) {
  return {
    relativePath: `${runId}/_v2/${plan.datasetId.split("/").at(-1)}.json`,
    record: buildRunRecordV2({
      plan,
      status,
      startedAt: "2026-09-04T00:00:00.000Z",
      completedAt: status === "completed" ? "2026-09-04T01:00:00.000Z" : null,
      samples: clipIds.map((clipId) => ({
        clipId,
        audioDurationSec: 2,
        responseMs: 400,
        status: "ok" as const,
        wordErrors: 0,
        referenceWords: 4,
        charErrors: 0,
        referenceChars: 20,
        isWarmup: false,
        overhead: {
          timingRegime: "ui-observed-paste" as const,
          hotkeyEdge: "keydown",
          timingClock: "monotonic",
        },
      })),
    }),
  };
}

describe("the commands a stage would run", () => {
  const map = manifests();

  test("the Wispr Flow stage uses --to, a target depth, so a re-run measures only the shortfall", () => {
    const opts = options({ toIndex: 400, datasets: [...DATASET_IDS], resultsRoot: "/tmp/out" });
    const stage = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z")[0];

    const command = stageCommand(opts, stage);
    expect(command.slice(0, 3)).toEqual(["bun", "run", "src/runner.ts"]);
    expect(command).toContain("--to");
    // `--samples` is a delta and running it twice would measure twice.
    expect(command).not.toContain("--samples");
    expect(command.join(" ")).toContain("--datasets test-clean,test-other,es_419,da_dk,hu_hu");
    expect(command.join(" ")).toContain("--batch 2026-09-v2");
    expect(command.join(" ")).toContain("--flow-hotkey option+z");
    expect(command.join(" ")).toContain("--out /tmp/out");
  });

  test("a resumed Wispr Flow stage passes the run id and nothing that could reselect", () => {
    const opts = options({ resultsRoot: "/tmp/out" });
    const stage = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z")[0];

    const command = stageCommand(opts, stage, "20260904_010203_2026-09-v2-flow");
    expect(command).toEqual([
      "bun",
      "run",
      "src/runner.ts",
      "--resume",
      "20260904_010203_2026-09-v2-flow",
      "--batch",
      "2026-09-v2",
      "--out",
      "/tmp/out",
      // F9: a resumed run has to find the audio it has left to play, and a committed
      // record stores `<codictate>` as a placeholder. Not a selection-changing flag: it
      // names where the clips live, not which clips they are.
      "--codictate",
      "/tmp/codictate",
    ]);
    // Every selection-changing flag is absent. `--batch` and `--out` are the two the
    // contract deliberately allows beside a resume.
    for (const flag of ["--from", "--to", "--datasets", "--samples", "--flow-hotkey"]) {
      expect([flag, command.includes(flag)]).toEqual([flag, false]);
    }
  });

  test("the Codictate stages split the datasets into splits and languages", () => {
    const opts = options({ toIndex: 400 });
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");

    const multilingual = stageCommand(opts, stages[1]).join(" ");
    expect(multilingual).toContain("--models large-v3-q5_0");
    expect(multilingual).toContain("--splits test-clean,test-other");
    expect(multilingual).toContain("--languages es_419,da_dk,hu_hu");
    expect(multilingual).toContain("--from 0 --to 400");
    expect(multilingual).toContain("--name 2026-09-v2-large-v3-q5-0");
    expect(multilingual).not.toContain("--name 2026-09-v2-large-v3-q5_0");

    // The Danish-pinned model gets `--splits none`, which is how Codictate's own README
    // says a language-pinned model is measured honestly.
    const danish = stageCommand(opts, stages[2]).join(" ");
    expect(danish).toContain("--models hviske-v5-tiny-q5_0");
    expect(danish).toContain("--splits none");
    expect(danish).toContain("--languages da_dk");
  });

  test("F2: a resumed Codictate stage resumes by run id and never re-issues --name", () => {
    // Against codictate as shipped a same-`--name` re-run refuses and exits 1 (SPEC
    // addendum §U), so the old "re-issue the fresh command, --to is idempotent" path
    // wedged the batch permanently on every subsequent invocation.
    const opts = options({ toIndex: 400 });
    const stage = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z")[1];

    const command = stageCommand(opts, stage, "2026-09-04_09-41-57_2026-09-v2-large-v3-q5_0");
    expect(command.slice(0, 4)).toEqual(["bun", "run", "bench:stt", "--"]);
    expect(command).toContain("--resume");
    expect(command).toContain("2026-09-04_09-41-57_2026-09-v2-large-v3-q5_0");
    expect(command).not.toContain("--name");
    // Every selection-changing flag absent; `--batch` and `--out` are the two §G allows.
    for (const flag of ["--from", "--to", "--models", "--splits", "--languages", "--samples"]) {
      expect([flag, command.includes(flag)]).toEqual([flag, false]);
    }
    expect(command).toContain("--batch");
    expect(command).toContain("--out");
  });

  test("F2: every Codictate stage passes --batch, so its run id can be found again", () => {
    // `runIdForStage` matches on `record.batchId`; without the flag it stayed undefined
    // for ever and the stage could never be resumed by name.
    const opts = options({ toIndex: 400 });
    for (const stage of stageMatrix(opts, map, "2026-09-04T00:00:00.000Z")) {
      const command = stageCommand(opts, stage);
      expect([stage.stageId, command.includes("--batch")]).toEqual([stage.stageId, true]);
      expect([stage.stageId, command[command.indexOf("--batch") + 1]]).toEqual([
        stage.stageId,
        opts.batchId,
      ]);
    }
  });

  test("F2: the by-hand resume command is offered for both harnesses", () => {
    const opts = options();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");

    expect(manualResumeCommand(opts, stages[0], "run-1").join(" ")).toContain(
      "bun run benchmark -- --resume run-1 --batch 2026-09-v2 --out",
    );
    expect(manualResumeCommand(opts, stages[1], "run-2").join(" ")).toContain(
      "bun run bench:stt -- --resume run-2 --batch 2026-09-v2 --out",
    );
    expect(manualResumeCommand(opts, stages[1], "run-2")).not.toContain(
      `# in ${opts.codictatePath}`,
    );
  });

  test("user smoke retry skips completed Flow and generates valid fresh Codictate name", () => {
    const root = temporaryRoot("user-smoke-");
    const opts = options({
      batchId: "2026-09-smoke",
      smoke: true,
      fromIndex: 0,
      toIndex: 5,
      resultsRoot: join(root, "smoke", "2026-09-smoke"),
      batchRoot: join(root, "smoke"),
      models: ["large-v3-q5_0"],
    });
    const map = manifests();
    loadOrCreateBatchManifest(opts, map, "2026-09-04T00:00:00.000Z");
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const records = stages[0].plans.map((entry) => {
      const plan = readRunPlan(join(batchDir(opts), "plans", stages[0].stageId, `${entry.dataset}.json`))!;
      return recordFor(plan, "flow-done", "completed", plan.orderedClipIds);
    });

    expect(stageDecision(opts, stages[0], records).decision).toBe("skip-completed");
    expect(stageDecision(opts, stages[1], records).decision).toBe("run");
    const command = stageCommand(opts, stages[1]);
    expect(command[command.indexOf("--name") + 1]).toBe("2026-09-smoke-large-v3-q5-0");
  });

  test("zero exit without complete records fails batch postcondition", () => {
    expect(() => assertStageCompletedAfterExit("codictate-large-v3", "resume")).toThrow(
      /exited 0 but did not complete/,
    );
    expect(() => assertStageCompletedAfterExit("codictate-large-v3", "skip-completed")).not.toThrow();
  });

  test("F3: a production Codictate stage writes into Codictate's own results tree", () => {
    const opts = options({ smoke: false });
    const stage = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z")[1];

    expect(codictateResultsRoot(opts)).toBe(join("/tmp/codictate", "benchmarks", "results"));
    expect(stageCommand(opts, stage)[stageCommand(opts, stage).indexOf("--out") + 1]).toBe(
      join("/tmp/codictate", "benchmarks", "results"),
    );
  });

  test("F3: a smoke Codictate stage writes nowhere near either production tree", () => {
    // Without this the SPEC §8 exclusion held for the Wispr Flow half only: five
    // rehearsal clips per dataset became ordinary completed v2 records in
    // `codictate/benchmarks/results/`, fed `poolSamples`, and advanced the cursor the
    // production batch measures from. Git-ignoring `results/smoke/` does not help,
    // because the records were not there.
    const root = temporaryRoot("f3-");
    const opts = options({
      smoke: true,
      resultsRoot: join(root, "smoke", "smoke-1"),
      batchRoot: join(root, "smoke"),
    });
    const out = codictateResultsRoot(opts);

    expect(out.startsWith(join(root, "smoke"))).toBe(true);
    expect(out.includes(join("codictate", "benchmarks", "results"))).toBe(false);
    for (const stage of stageMatrix(opts, map, "2026-09-04T00:00:00.000Z")) {
      const command = stageCommand(opts, stage);
      const outValue = command[command.indexOf("--out") + 1];
      expect([stage.stageId, outValue.startsWith(join(root, "smoke"))]).toEqual([
        stage.stageId,
        true,
      ]);
      expect([stage.stageId, outValue.includes("benchmarks")]).toEqual([stage.stageId, false]);
    }
  });

  test("no stage ever asks Codictate to offload its models", () => {
    const opts = options();
    for (const stage of stageMatrix(opts, map, "2026-09-04T00:00:00.000Z")) {
      expect(stageCommand(opts, stage)).not.toContain("--offload-models");
    }
  });

  test("no stage command publishes, deploys or aggregates", () => {
    const opts = options();
    for (const stage of stageMatrix(opts, map, "2026-09-04T00:00:00.000Z")) {
      const command = stageCommand(opts, stage).join(" ");
      for (const forbidden of ["--publish", "--deploy", "--aggregate", "--report-only"]) {
        expect([stage.stageId, forbidden, command.includes(forbidden)]).toEqual([
          stage.stageId,
          forbidden,
          false,
        ]);
      }
    }
  });

  test("the printed command is quotable, so a human can paste it", () => {
    expect(shellQuote(["bun", "run", "x", "--device", "BlackHole 2ch"])).toBe(
      "bun run x --device 'BlackHole 2ch'",
    );
    expect(shellQuote(["--note", "a; b"])).toBe("--note 'a; b'");
  });

  test("stage ids are stable, because the state files are named after them", () => {
    expect(stageIdOf("wispr-flow", "wispr-flow")).toBe("wispr-flow");
    expect(stageIdOf("codictate", "large-v3-q5_0")).toBe("codictate-large-v3-q5_0");
  });
});

describe("F1: a record only completes its OWN series", () => {
  /**
   * The v2 fingerprint is `sha256` over the ordered clipId list and nothing else
   * (SPEC addendum §F), so it is **identical across harnesses and models by design** -
   * that is what proves both products measured the same clips. Matching a record to a
   * plan on the fingerprint alone therefore matched every product to every other
   * product's plan: a completed Wispr Flow stage marked both Codictate stages complete,
   * the orchestrator skipped them without ever invoking Codictate, and the readiness
   * report said all three had run.
   */
  function batch(): { opts: PublicationOptions; map: Map<DatasetId, ManifestEntry[]> } {
    const root = temporaryRoot("f1-");
    const opts = options({
      resultsRoot: root,
      batchRoot: join(root, "batches"),
      datasets: [...DATASET_IDS],
      // Two Codictate models, so the three stages are the three the collision was
      // between: Flow, one multilingual model, one Danish-pinned one. The fingerprint
      // they share on `da_dk` is the whole point of the defect.
      models: [...SMOKE_MODELS],
    });
    const map = manifests();
    loadOrCreateBatchManifest(opts, map, "2026-09-04T00:00:00.000Z");
    return { opts, map };
  }

  /** A completed record for one (harness, model, dataset), over the whole plan. */
  function completedRecord(
    opts: PublicationOptions,
    map: Map<DatasetId, ManifestEntry[]>,
    harness: "wispr-flow" | "codictate",
    model: string,
    dataset: DatasetId,
  ) {
    const plan = runPlanFor({
      runId: `${harness}-${model}-${dataset}`,
      batchId: opts.batchId,
      harness,
      model,
      dataset,
      entries: map.get(dataset)!,
      fromIndex: opts.fromIndex,
      toIndex: opts.toIndex,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    return recordFor(plan, plan.runId, "completed", plan.orderedClipIds);
  }

  test("the three stages' da_dk plans share one fingerprint, which is the point", () => {
    const { opts, map } = batch();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const fingerprints = stages.map(
      (stage) => stage.plans.find((plan) => plan.dataset === "da_dk")!.fingerprintV2.value,
    );

    // All three identical. Anything that keys stage completion on this alone is wrong.
    expect(new Set(fingerprints).size).toBe(1);
    expect(fingerprints).toHaveLength(3);
  });

  test("a fully completed Wispr Flow stage does NOT complete either Codictate stage", () => {
    const { opts, map } = batch();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const flowRecords = DATASET_IDS.map((dataset) =>
      completedRecord(opts, map, "wispr-flow", "wispr-flow", dataset),
    );

    const decisions = stages.map((stage) => stageDecision(opts, stage, flowRecords));
    expect(decisions.map((entry) => [entry.stage.stageId, entry.decision])).toEqual([
      ["wispr-flow", "skip-completed"],
      ["codictate-large-v3-q5_0", "run"],
      ["codictate-hviske-v5-tiny-q5_0", "run"],
    ]);
    // And no Wispr Flow clip is credited to a Codictate cursor.
    for (const entry of decisions.slice(1)) {
      for (const progress of Object.values(entry.state.progress ?? {})) {
        expect(progress.cursor).toBe(0);
      }
    }
  });

  test("one Codictate model's records do not complete the other Codictate model", () => {
    const { opts, map } = batch();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const large = DATASET_IDS.map((dataset) =>
      completedRecord(opts, map, "codictate", "large-v3-q5_0", dataset),
    );

    const decisions = stages.map((stage) => stageDecision(opts, stage, large));
    expect(decisions.map((entry) => [entry.stage.stageId, entry.decision])).toEqual([
      ["wispr-flow", "run"],
      ["codictate-large-v3-q5_0", "skip-completed"],
      ["codictate-hviske-v5-tiny-q5_0", "run"],
    ]);
  });

  test("every stage completes only when its own series has measured every clip", () => {
    const { opts, map } = batch();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const all = [
      ...DATASET_IDS.map((dataset) => completedRecord(opts, map, "wispr-flow", "wispr-flow", dataset)),
      ...DATASET_IDS.map((dataset) =>
        completedRecord(opts, map, "codictate", "large-v3-q5_0", dataset),
      ),
      completedRecord(opts, map, "codictate", "hviske-v5-tiny-q5_0", "da_dk"),
    ];

    expect(stages.map((stage) => stageDecision(opts, stage, all).decision)).toEqual([
      "skip-completed",
      "skip-completed",
      "skip-completed",
    ]);
  });

  test("a record of the right series over a different range is reported as other-clips", () => {
    const { opts, map } = batch();
    const stages = stageMatrix(opts, map, "2026-09-04T00:00:00.000Z");
    const plan = readRunPlan(
      join(batchDir(opts), "plans", "wispr-flow", "da_dk.json"),
    )!;
    const elsewhere = runPlanFor({
      runId: "flow-elsewhere",
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: map.get("da_dk")!,
      fromIndex: 20,
      toIndex: 30,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const records = [
      recordFor(elsewhere, "flow-elsewhere", "completed", elsewhere.orderedClipIds),
      completedRecord(opts, map, "codictate", "large-v3-q5_0", "da_dk"),
    ];

    const cursor = v2CursorFor(plan, records);
    expect(cursor.cursor).toBe(0);
    expect(cursor.skipped.map((entry) => entry.reason).sort()).toEqual([
      "other-clips",
      "other-series",
    ]);
    expect(stageDecision(opts, stages[0], records).decision).toBe("run");
  });
});

describe("smoke output is excluded from every production read", () => {
  test("isSmokePath matches the directory and not a run whose name mentions smoke", () => {
    expect(isSmokePath("smoke")).toBe(true);
    expect(isSmokePath(join("smoke", "batch-1", "run", "_v2", "da_dk.json"))).toBe(true);
    expect(isSmokePath("20260904_000000_smoke-check")).toBe(false);
    expect(isSmokePath(join("batches", "2026-09-v2", "batch.json"))).toBe(false);
  });

  test("a production scan skips smoke records and finds production ones", () => {
    const root = temporaryRoot();
    const map = manifests();
    const plan = runPlanFor({
      runId: "run-1",
      harness: "wispr-flow",
      model: "wispr-flow",
      dataset: "da_dk",
      entries: map.get("da_dk")!,
      fromIndex: 0,
      toIndex: 5,
      createdAt: "2026-09-04T00:00:00.000Z",
    });
    const record = recordFor(plan, "run-1", "completed", plan.orderedClipIds).record;

    saveRunRecordV2(join(root, "20260904_000000_production"), "da_dk", record);
    saveRunRecordV2(join(root, "smoke", "batch-1", "20260904_000000_rehearsal"), "da_dk", record);

    const production = scanRunRecordsV2(root);
    expect(production).toHaveLength(1);
    expect(production[0].relativePath.includes("smoke")).toBe(false);

    // The smoke chain reads its own tree on purpose, so the opt-in exists.
    expect(scanRunRecordsV2(root, { includeSmoke: true })).toHaveLength(2);
  });

  test("results/smoke/ is git-ignored", () => {
    const ignore = Bun.file(resolve(import.meta.dir, "../.gitignore"));
    return ignore.text().then((text) => {
      expect(text.split("\n").map((line) => line.trim())).toContain("results/smoke/");
    });
  });

  test("a v1 results.json is never mistaken for a v2 record", () => {
    const root = temporaryRoot();
    const runDir = join(root, "20260902_181511_wispr-flow-all-400");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "results.json"),
      JSON.stringify({ schemaVersion: 1, runId: "legacy", results: {} }),
    );

    expect(scanRunRecordsV2(root)).toEqual([]);
  });
});

// -- CLI level: --dry-run must be safe to run and honest about the plan --

const datasetsDir = resolve(import.meta.dir, "../../codictate/benchmarks/datasets");
const haveCorpus = existsSync(datasetsDir);

async function dryRun(root: string, ...args: string[]) {
  const repo = resolve(import.meta.dir, "..");
  const child = Bun.spawn(
    ["bun", resolve(repo, "src/publication.ts"), ...args, "--out", root, "--dry-run"],
    { cwd: repo, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function filesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path));
    }
  };
  if (existsSync(root)) walk(root);
  return found.sort();
}

describe.skipIf(!haveCorpus)("--dry-run", () => {
  test("writes only the batch manifest and its Run Plans", async () => {
    const root = temporaryRoot("publication-dry-");
    const { exitCode, stdout } = await dryRun(root, "--batch", "dry-1", "--smoke");

    expect(exitCode).toBe(0);
    // The manifest and the plans are the only side effect, and they are the thing that
    // makes the printed plan reproducible.
    expect(filesUnder(root)).toEqual([
      join("smoke", "dry-1", "batch.json"),
      join("smoke", "dry-1", "plans", "codictate-hviske-v5-tiny-q5_0", "da_dk.json"),
      join("smoke", "dry-1", "plans", "codictate-large-v3-q5_0", "da_dk.json"),
      join("smoke", "dry-1", "plans", "codictate-large-v3-q5_0", "es_419.json"),
      join("smoke", "dry-1", "plans", "codictate-large-v3-q5_0", "hu_hu.json"),
      join("smoke", "dry-1", "plans", "codictate-large-v3-q5_0", "test-clean.json"),
      join("smoke", "dry-1", "plans", "codictate-large-v3-q5_0", "test-other.json"),
      join("smoke", "dry-1", "plans", "wispr-flow", "da_dk.json"),
      join("smoke", "dry-1", "plans", "wispr-flow", "es_419.json"),
      join("smoke", "dry-1", "plans", "wispr-flow", "hu_hu.json"),
      join("smoke", "dry-1", "plans", "wispr-flow", "test-clean.json"),
      join("smoke", "dry-1", "plans", "wispr-flow", "test-other.json"),
    ]);
    expect(stdout).toContain("no adapter was invoked, no clip was transcribed");
    // No run directory, no report, no staging output.
    expect(filesUnder(root).some((path) => path.includes("results.json"))).toBe(false);
    expect(filesUnder(root).some((path) => path.includes("staging"))).toBe(false);
  });

  test("prints per-stage clip counts, fingerprints and a run/skip decision", async () => {
    const root = temporaryRoot("publication-dry-");
    const { stdout } = await dryRun(root, "--batch", "dry-2", "--smoke", "--clips-per-dataset", "5");

    expect(stdout).toContain("1. wispr-flow wispr-flow -> RUN");
    expect(stdout).toContain("2. codictate large-v3-q5_0 -> RUN");
    expect(stdout).toContain("3. codictate hviske-v5-tiny-q5_0 -> RUN");
    // 5 datasets x 5 + 5 x 5 + 5 = 55.
    expect(stdout).toContain("Total:     55 scored clips across 3 stages");
    expect(stdout).toContain("To run:    55 scored clips remain");
    expect(stdout).toMatch(/fingerprintV2 [0-9a-f]{16}/);
    expect(stdout).toContain("clips [0, 5) = 5 scored + 3 warmup replays");
    expect(stdout).toContain("Publishes: nothing. Staging reports only, models left on disk.");
    expect(stdout).toContain(
      "Response times are not measured the same way for both products",
    );
  });

  test("the second identical invocation skips every completed stage and has nothing to run", async () => {
    const root = temporaryRoot("publication-dry-");
    const args = ["--batch", "dry-3", "--smoke", "--clips-per-dataset", "5"];
    await dryRun(root, ...args);

    // Stand in for the three stages having run, by writing the v2 records they would
    // have written. Reading the records rather than a state file is the point: a stage
    // cannot be marked complete by a file that outlived the measurements.
    const batchRoot = join(root, "smoke", "dry-3");
    for (const stageId of readdirSync(join(batchRoot, "plans"))) {
      for (const file of readdirSync(join(batchRoot, "plans", stageId))) {
        const plan = JSON.parse(
          await Bun.file(join(batchRoot, "plans", stageId, file)).text(),
        ) as ReturnType<typeof runPlanFor>;
        saveRunRecordV2(
          join(root, "smoke", "dry-3", `20260904_000000_${stageId}`),
          file.replace(/\.json$/, ""),
          buildRunRecordV2({
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
              overhead: {
                timingRegime: "ui-observed-paste" as const,
                hotkeyEdge: "keydown",
                timingClock: "monotonic",
              },
            })),
          }),
        );
      }
    }

    const { exitCode, stdout } = await dryRun(root, ...args);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Reusing the batch manifest written at");
    expect(stdout).toContain("1. wispr-flow wispr-flow -> SKIP (completed)");
    expect(stdout).toContain("2. codictate large-v3-q5_0 -> SKIP (completed)");
    expect(stdout).toContain("3. codictate hviske-v5-tiny-q5_0 -> SKIP (completed)");
    expect(stdout).toContain("To run:    0 scored clips remain");
  });

  test("a second invocation with a different range is refused, not silently re-planned", async () => {
    const root = temporaryRoot("publication-dry-");
    await dryRun(root, "--batch", "dry-4", "--smoke", "--clips-per-dataset", "5");
    const { exitCode, stderr } = await dryRun(
      root,
      "--batch",
      "dry-4",
      "--smoke",
      "--clips-per-dataset",
      "7",
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("already exists and describes a different batch");
    expect(stderr).toContain("range [0, 5) vs [0, 7)");
  });
});
