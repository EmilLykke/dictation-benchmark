import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { arch, cpus, platform, release, totalmem } from "node:os";
import {
  MINIMUM_VIRTUAL_MIC_FLOW_VERSION,
  supportsVirtualMicrophone,
  WisprFlowAdapter,
} from "./adapters/wispr-flow";
import { buildManifest } from "./manifest";
import {
  consumableEntries,
  deriveCursors,
  formatPlanLine,
  fromIndexError,
  incompleteRunsFor,
  ManifestFingerprintMismatch,
  manifestFingerprint,
  planDataset,
  resumePlan,
  scanRunRecords,
  selectionFor,
  WARMUP_COUNT,
  type DatasetPlan,
  type DatasetSelection,
  type DepthRequest,
  type FingerprintConflict,
} from "./selection";
import { computeCer, computeWer, type CerResult, type WerResult } from "./scoring";
import {
  DATASET_IDS,
  type DatasetId,
  type ManifestEntry,
  type ProductMetadata,
  type TranscriptionRequest,
} from "./types";
import { buildCodictateCheckpoint, buildCodictateResults } from "./codictate-compat";
import {
  CODICTATE_PATH_PLACEHOLDER,
  datasetsRoot,
  portableRun,
} from "./portable-paths";
import {
  assertNoOverlappingIncompleteRun,
  assertResumeFlags,
  clipIdFromAbsoluteAudioPath,
  clipIdFromRelativeAudioPath,
  type RunPlan,
  type SampleMeasurementV2,
} from "./contract";
import { runPlanForDatasetPlan, sessionSelection } from "./v2-plan";
import { DEFAULT_FLOW_HOTKEY, parseHotkey } from "./publication-hotkey";
import {
  buildRunRecordV2,
  planPath,
  readRunPlan,
  saveRunPlanOnce,
  saveRunRecordV2,
} from "./v2-record";

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Consumable clips `--samples` runs when the flag is omitted. A delta, not a depth:
 * see `DepthRequest`.
 */
const DEFAULT_SAMPLES = 20;

/**
 * How often the bridge re-reads the receiver window while waiting for text.
 *
 * Since 2026-09-04 this is a **fallback** granularity, not the granularity of the
 * measurement. The bridge stamps text changes from
 * `NSTextStorage.didProcessEditingNotification` on the receiver `NSTextView`, so on the
 * event path the stamps carry no interval bias and the reply says `textChangeBiasMs: 0`.
 * Polling remains the documented fallback and also governs how fast *stability* is
 * declared; on that path the reply states the whole interval as its bias. It was 50ms
 * and hardcoded in the bridge; 10ms is kept because it still bounds the fallback's
 * worst case while sleeping between reads rather than spinning.
 */
const DEFAULT_POLL_INTERVAL_MS = 10;

/**
 * The interval runs made before `pollIntervalMs` existed actually used, hardcoded in
 * `main.swift`. Only used to fill the field in when resuming one of those runs, so
 * the second half of a run keeps the granularity the first half had.
 */
const LEGACY_POLL_INTERVAL_MS = 50;

export interface RunConfig {
  /**
   * Absolute path to the Codictate checkout in memory; serialised as
   * `<codictate>` so a committed run does not name the machine that made it.
   */
  codictatePath: string;
  datasets: DatasetId[];
  /**
   * `--samples N`: a DELTA, not a depth. N consumable clips that this repo has not
   * measured before for this product, taken from wherever the cursor for each
   * dataset currently sits. Destructive by default — running the same command twice
   * consumes twice — which is why a plan preview is printed before any clip runs.
   *
   * Absent when the depth was expressed with `--to` instead.
   */
  samples?: number;
  /**
   * `--to N`: a TARGET DEPTH. Run whatever is needed for N consumable clips to have
   * been measured in total, and do nothing at all where that is already true. This
   * is what makes re-running an interrupted overnight command safe.
   *
   * Absent when the depth was expressed with `--samples` instead.
   */
  to?: number;
  deviceName: string;
  /**
   * The dictation shortcut the bridge posts, as a virtual key code and its modifiers.
   *
   * Recorded on the run because it is a condition of the measurement and cannot be
   * verified from this side: Wispr Flow exposes no supported automation API, so the
   * operator sets its Hands-free shortcut by hand and passing the wrong one here does
   * not error — it times out on every clip.
   *
   * **Option+Z, key code 6.** One default, here and in
   * `src/publication-hotkey.ts::DEFAULT_FLOW_HOTKEY`: a second one would let a direct
   * invocation of this runner post a shortcut Flow no longer listens on, and the result
   * would be four hundred timeouts rather than an error.
   *
   * The runs under `results/` were measured with **Option+Space** (key code 49), which
   * is one of the two reasons they are not v2-comparable — the other being the ~85 ms
   * keydown-edge bias the bridge has since fixed. That is an archival fact about those
   * records, not a value to keep a fallback for; `--flow-hotkey` is how a run states a
   * different shortcut, and every run records what it used.
   */
  hotkey: { keyCode: number; modifiers: Array<"command" | "control" | "fn" | "option" | "shift"> };
  leadMs: number;
  tailMs: number;
  /**
   * Per-clip deadline in milliseconds, counted from the moment dictation is
   * stopped. `main.swift` stamps `stoppedAt` after playback and the tail have
   * already elapsed, so this is grace granted *after* the clip finished
   * playing: it is flat by construction and every clip gets all of it,
   * whatever its length.
   */
  timeoutMs: number;
  /**
   * Legacy field, written only by runs made while the timeout was briefly
   * computed as `audioDurationSec * 1000 + timeoutBudgetMs`. That formula
   * double-counted the clip, because the bridge already applies the value
   * after playback. Never written for new runs; kept so those `results.json`
   * files still parse, and read on resume when `timeoutMs` is absent.
   */
  timeoutBudgetMs?: number;
  /**
   * `--batch <id>`: the publication batch this run is a stage of, when it was launched
   * by `src/publication.ts`. Recorded so a stage can be found again by batch rather
   * than by directory listing. Absent for a hand-launched run.
   */
  batchId?: string;
  stableMs: number;
  /**
   * How often the bridge re-reads the receiver window while waiting for text, and so
   * the granularity of every `stopToFirstTextMs` in the run. Recorded for the same
   * reason `stableMs` is: it is a term in the measurement, and a reader who cannot
   * see it cannot correct for it.
   *
   * Optional on the type only because runs written before it existed have no value;
   * `withPollIntervalMs` fills those in on resume. Always written for new runs.
   */
  pollIntervalMs?: number;
  configurationNote: string;
}

export interface SampleResult {
  /** The per-corpus display id. **Not identity** — see `ManifestEntry.id`. */
  id: string;
  /**
   * Canonical clip identity (`fleurs/da_dk/audio/test/<hash>.wav`).
   *
   * Optional on the type only because runs written before it existed have none; for
   * those `sampleClipId` re-derives it from the record's own portable `audioPath`,
   * which is already this exact string. Always written for new samples.
   */
  clipId?: string;
  /** FLEURS TSV column 0. Metadata, and it repeats. Absent for LibriSpeech. */
  sentenceId?: string;
  warmup: boolean;
  audioPath: string;
  audioDurationSec: number;
  language: string;
  reference: string;
  hypothesis: string;
  status: "ok" | "timeout" | "failed";
  wer: WerResult;
  cer?: CerResult;
  audioPlaybackMs: number;
  wallClockMs?: number;
  stopToFirstTextMs: number | null;
  stopToStableTextMs: number | null;
  /** See `TranscriptionResult`. The harness's measured share of the line above. */
  stopToFirstTextHarnessMs?: number | null;
  /** See `TranscriptionResult`. Measured, and outside the window above. */
  outputDeviceRestoreMs?: number | null;
  /**
   * **The response metric.** See `TranscriptionResult.stopToLastTextChangeMs`.
   *
   * Optional because samples recorded before 2026-09-04 have none. Where it is absent
   * the only readable number is `stopToStableTextMs`, which carries the 750 ms
   * stability delay, so such a sample is legacy for speed and
   * `src/contract/timing.ts::speedCompatible` keeps it out of every pooled ratio.
   */
  stopToLastTextChangeMs?: number | null;
  /** See `TranscriptionResult`. The confirmation delay, outside the window. */
  stabilityDelayMs?: number | null;
  /** See `TranscriptionResult`. `"event"` or the polling fallback. */
  textChangeSource?: "event" | "poll" | null;
  /** See `TranscriptionResult`. Text changes observed inside the window. */
  textChangeCount?: number | null;
  /** See `TranscriptionResult`. Stated bias: 0 on the event path, one poll otherwise. */
  textChangeBiasMs?: number | null;
  /** See `TranscriptionResult`. Proves lead + playback + tail precede the stop stamp. */
  startToStopMs?: number | null;
  /** See `TranscriptionResult`. Provenance for pooling. */
  timingClock?: "monotonic" | null;
  /** See `TranscriptionResult`. Provenance for pooling. */
  hotkeyEdge?: "keydown" | null;
  diagnostic?: string;
}

interface DatasetResult {
  samples: SampleResult[];
  /**
   * The half-open range of consumable entries this run measured for this dataset,
   * plus the fingerprint of the ordered manifest those offsets index into.
   *
   * This is the whole of the accumulation record. The cursor for a dataset is the
   * maximum `endIndex` over every run in `results/` whose `manifestFingerprint`
   * matches the current manifest, so the results tree stays the source of truth and
   * there is no separate ledger that can drift away from it.
   *
   * Absent on runs recorded before this scheme existed; such a run contributes
   * nothing to a cursor until it is backfilled (see `scripts/backfill-selection.ts`).
   */
  selection?: DatasetSelection;
  aggregate?: {
    wer: number;
    substitutions: number;
    insertions: number;
    deletions: number;
    referenceWords: number;
    cer?: number;
    characterErrors?: number;
    referenceChars?: number;
    scoredSamples: number;
    failures: number;
    /**
     * Mean of `stopToLastTextChangeMs`, falling back to `stopToStableTextMs` for
     * samples recorded before the bridge emitted it.
     *
     * A run-local diagnostic only. The published speed figure is the **pooled**
     * `responseMsPerAudioSec` in `stt.json`, because a mean of per-clip numbers
     * weights a 2-second clip the same as a 30-second one.
     */
    meanResponseMs: number | null;
    /**
     * Mean of `stopToStableTextMs`, which **includes** the 750 ms stability
     * confirmation. Kept under its old name and its old meaning. **Not a response
     * time**, and never a substitute for `meanResponseMs`.
     */
    meanStopToStableTextMs: number | null;
  };
}

interface BenchmarkRun {
  schemaVersion: 1;
  status: "running" | "completed";
  runId: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  product: ProductMetadata;
  hardware: {
    platform: string;
    release: string;
    arch: string;
    cpu: string;
    ram?: string;
    os?: string;
    osVersion?: string;
  };
  config: RunConfig;
  results: Partial<Record<DatasetId, DatasetResult>>;
}

interface CliOptions {
  name?: string;
  /**
   * `--resume <runId|runDir>`: the run to continue, **named explicitly**.
   *
   * Never "the latest unfinished run". That search has a silent failure mode — it
   * resumes the wrong run and files a partial numerator against clips it never saw —
   * and the operator always knows which run they mean. A bare run id is resolved under
   * the results root; a path is taken as given, so the shape the README has always
   * documented still works.
   */
  resume?: string;
  dryRun: boolean;
  /**
   * `--from N`: an explicit start index into the CONSUMABLE range, overriding the
   * cursor for this run only.
   *
   * Deliberately not part of {@link RunConfig} and therefore never serialised: it is
   * an instruction about where to start, not a property of the run, and the range it
   * produces is already recorded verbatim in that dataset's `selection`. Keeping it
   * off the record also means a `--resume` can never pick a rewind back up out of a
   * file, which matters because `--from` and `--resume` are refused together.
   */
  from?: number;
  /**
   * `--out <dir>`: the results root this invocation reads its cursor from and writes
   * its run directory into. Defaults to `results/`.
   *
   * The cursor is derived from the tree, so pointing a run at another tree is also how
   * it is kept out of the production cursor: the orchestrator's smoke chain passes
   * `--out results/smoke/<batch>`, and nothing under `results/smoke/` is ever scanned
   * by a production read (`src/v2-record.ts::isSmokePath`).
   *
   * Deliberately **not** a selection-changing flag, so it is absent from
   * `RESUME_FORBIDDEN_FLAGS`: it moves where a report is written, not what was
   * measured.
   */
  out?: string;
  config: RunConfig;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const resultsRoot = options.out
    ? resolve(options.out)
    : resolve(import.meta.dir, "../results");
  let run: BenchmarkRun;
  let runDir: string;

  if (options.resume) {
    runDir = resolveRunDir(resultsRoot, options.resume);
    run = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8")) as BenchmarkRun;
    run.config = withCodictatePath(
      withPollIntervalMs(withTimeoutMs(run.config)),
      options.config.codictatePath,
    );
  } else {
    if (!options.name) throw new Error("--name is required for a new run");
    const runId = `${timestamp()}_${slug(options.name)}`;
    runDir = join(resultsRoot, runId);
    if (existsSync(runDir)) throw new Error(`Run directory already exists: ${runDir}`);
    run = {
      schemaVersion: 1,
      status: "running",
      runId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      product: { id: "wispr-flow", label: "Wispr Flow", version: null },
      hardware: {
        platform: platform(),
        release: release(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        ram: `${Math.round(totalmem() / 1024 / 1024 / 1024)} GB`,
        os: platform() === "darwin" ? "macOS" : platform(),
        osVersion: osVersion(),
      },
      config: options.config,
      results: {},
    };
  }

  const datasetsDirectory = datasetsRoot(run.config.codictatePath);
  const manifests = new Map<DatasetId, ManifestEntry[]>();
  const plans = buildPlan(run, resultsRoot, options.from, manifests);
  printPlan(run, runDir, plans, options.from);
  if (options.dryRun) return;
  if (plans.every((plan) => plan.clips.length === 0) ||
      (options.resume && plansHaveNoRemaining(runDir, run, plans, datasetsDirectory))) {
    if (options.resume) {
      finalizeRunArtifacts(runDir, run, plans, manifests, datasetsDirectory);
      console.log(`\nCompleted: ${join(runDir, "results.json")}`);
      console.log(`Comparable: ${join(runDir, "stt.json")}`);
      return;
    }
    console.log("\nNothing left to measure at this depth. Flow was not touched.");
    return;
  }

  const adapter = new WisprFlowAdapter();
  const stop = async () => adapter.close().catch(() => undefined);
  process.on("SIGINT", () => void stop().finally(() => process.exit(130)));
  process.on("SIGTERM", () => void stop().finally(() => process.exit(143)));

  try {
    const product = await adapter.metadata();
    const preflight = await adapter.preflight(run.config.deviceName);
    if (!preflight.productRunning) throw new Error("Wispr Flow is not running");
    if (!supportsVirtualMicrophone(product.version)) {
      throw new Error(
        `Wispr Flow ${product.version ?? "unknown"} is older than virtual-microphone release ${MINIMUM_VIRTUAL_MIC_FLOW_VERSION}. Update Flow first.`,
      );
    }
    if (!preflight.outputDeviceFound) {
      throw new Error(
        `Output device "${run.config.deviceName}" not found. Available: ${preflight.outputDevices.join(", ") || "none"}`,
      );
    }
    if (!preflight.accessibilityTrusted) {
      throw new Error(
        "Accessibility permission missing for flow-bridge. Add it under System Settings → Privacy & Security → Accessibility, then retry.",
      );
    }
    run.product = product;
    mkdirSync(runDir, { recursive: true });
    saveRun(runDir, run);
    saveCheckpoint(runDir, run);

    for (const plan of plans) {
      const dataset = plan.dataset as DatasetId;
      if (plan.clips.length === 0) {
        console.log(`\n[${dataset}] ${formatPlanLine(plan)}`);
        continue;
      }
      const result = (run.results[dataset] ??= { samples: [] });
      // The immutable Run Plan, written before the first clip and re-read rather than
      // re-derived on every later session. `saveRunPlanOnce` refuses to overwrite a
      // plan with a different fingerprint, which is what stops the second invocation of
      // `--samples 400` from meaning "another 400 clips" under the first 400's name.
      const runPlan = saveRunPlanOnce(
        runDir,
        dataset,
        runPlanForDatasetPlan(plan, manifests.get(dataset)!, {
          runId: run.runId,
          ...(run.config.batchId === undefined ? {} : { batchId: run.config.batchId }),
          model: run.product.id,
          createdAt: run.createdAt,
        }),
      );
      const entries = sessionEntries(plan);
      // Defect 1: this set used to be keyed on `sample.id`, which for FLEURS is the
      // *sentence* id and repeats. Danish has 930 clips behind 350 distinct values, so
      // two thirds of a Danish range looked like clips already captured and were
      // skipped, while the recorded range still claimed the full depth: a 400-clip
      // range resolved to 264 distinct audio files (measured; see
      // `tests/fleurs-identity.manual.ts`). Keyed on `clipId` - the audio file's
      // corpus-relative path - a 400-clip range invokes the adapter on 400 distinct
      // files.
      //
      // The archived `20260902_181511_wispr-flow-all-400` is **not** an instance of the
      // skip and must not be quoted as one: it predates intra-run deduplication and
      // holds 400 samples with 400 distinct audio paths. It is evidence that the ids
      // collide - 264 distinct across its 400 Danish samples - and nothing more.
      const completed = new Set(
        result.samples.map((sample) => sampleClipId(sample, datasetsDirectory)),
      );
      if (!result.selection && result.samples.some((sample) => !sample.warmup)) {
        throw new Error(
          `${dataset} in ${runDir} holds scored samples but no recorded range, so this run ` +
            `predates consumable ranges. Backfill it with scripts/backfill-selection.ts before ` +
            `resuming, or start a new run; continuing would mix two selection schemes in one ` +
            `dataset and record a depth neither of them reached.`,
        );
      }
      // The contract decides what this session plays. Three lists, not one, because
      // the three have different rules and conflating them was defect 6.
      const session = sessionSelection(runPlan, completed);
      const remaining = new Set(session.remaining);
      result.selection = selectionFor(plan, measuredPrefix(plan, completed));
      saveRun(runDir, run);
      saveV2(runDir, dataset, runPlan, run, result.samples, "incomplete", datasetsDirectory);
      if (session.scoredToSkip.length > 0) {
        console.log(
          `\n[${dataset}] resuming: ${session.warmupsToReplay.length} warmup replays, ` +
            `${session.scoredToSkip.length} scored clips already measured and skipped, ` +
            `${session.remaining.length} left. A recorded failure or timeout counts as ` +
            `measured and is not replayed.`,
        );
      }
      if (plan.truncated) {
        console.warn(
          `\n[${dataset}] EXHAUSTED: depth ${plan.requestedEndIndex} requested but only ` +
            `${plan.consumableCount} consumable clips exist. Running the ${plan.clips.length} that ` +
            `remain and recording depth ${plan.endIndex}; no clip is re-used.`,
        );
      }
      console.log(
        `\n[${dataset}] ${entries.length} clips: ${plan.warmups.length} warmup replays + ` +
          `consumable ${plan.startIndex + 1}-${plan.endIndex} of ${plan.consumableCount}`,
      );

      for (const slot of sessionPlaylist(entries, plan.warmups.length, remaining)) {
        const { entry, index, warmup } = slot;
        if (!slot.play) {
          console.log(`  ${index + 1}/${entries.length} ${entry.id} already captured`);
          continue;
        }

        process.stdout.write(`  ${index + 1}/${entries.length} ${entry.id}${warmup ? " (warmup)" : ""} ... `);
        const startedAt = performance.now();
        const transcription = await adapter.transcribe(transcribeRequest(run.config, entry));
        const wallClockMs = performance.now() - startedAt;
        const scoredHypothesis = transcription.status === "ok" ? transcription.transcript : "";
        const wer = computeWer(entry.transcript, scoredHypothesis);
        const cer = entry.rawTranscript === undefined
          ? undefined
          : computeCer(entry.rawTranscript, scoredHypothesis);
        result.samples.push({
          id: entry.id,
          clipId: entry.clipId,
          ...(entry.sentenceId === undefined ? {} : { sentenceId: entry.sentenceId }),
          warmup,
          audioPath: entry.audioPath,
          audioDurationSec: entry.audioDurationSec,
          language: entry.language,
          reference: entry.transcript,
          hypothesis: transcription.transcript,
          status: transcription.status,
          wer,
          cer,
          audioPlaybackMs: transcription.audioPlaybackMs,
          wallClockMs,
          stopToFirstTextMs: transcription.stopToFirstTextMs,
          stopToStableTextMs: transcription.stopToStableTextMs,
          stopToFirstTextHarnessMs: transcription.stopToFirstTextHarnessMs,
          outputDeviceRestoreMs: transcription.outputDeviceRestoreMs,
          // The response metric and its provenance, straight through from
          // `Bridge.timingFields`. `stopToLastTextChangeMs` is the number that becomes
          // a v2 Sample's `responseMs`; `stopToStableTextMs` above is kept for
          // continuity and is NOT a response time.
          stopToLastTextChangeMs: transcription.stopToLastTextChangeMs,
          stabilityDelayMs: transcription.stabilityDelayMs,
          textChangeSource: transcription.textChangeSource,
          textChangeCount: transcription.textChangeCount,
          textChangeBiasMs: transcription.textChangeBiasMs,
          startToStopMs: transcription.startToStopMs,
          timingClock: transcription.timingClock,
          hotkeyEdge: transcription.hotkeyEdge,
          diagnostic: transcription.diagnostic,
        });
        result.aggregate = aggregate(result.samples);
        completed.add(entry.clipId);
        remaining.delete(entry.clipId);
        // Kept honest after every clip, so a run that dies halfway advances the
        // cursor by the clips it finished and not by the clips it intended.
        result.selection = selectionFor(plan, measuredPrefix(plan, completed));
        // Three atomic writes per scored clip, every one of them fsynced and renamed
        // over its target. Never batched: a batch of 50 costs up to fifty clips of
        // real-time playback on a crash, and afterwards those clips are
        // indistinguishable from clips that were never planned.
        saveRun(runDir, run);
        saveCheckpoint(runDir, run, dataset);
        saveV2(runDir, dataset, runPlan, run, result.samples, "incomplete", datasetsDirectory);
        console.log(
          `${transcription.status}; WER ${(wer.wer * 100).toFixed(1)}%; ` +
            `response ${formatMs(transcription.stopToLastTextChangeMs)} ` +
            `(stable ${formatMs(transcription.stopToStableTextMs)}, includes ${transcription.stabilityDelayMs}ms wait)`,
        );
      }
    }

    finalizeRunArtifacts(runDir, run, plans, manifests, datasetsDirectory);
    console.log(`\nCompleted: ${join(runDir, "results.json")}`);
    console.log(`Comparable: ${join(runDir, "stt.json")}`);
  } finally {
    await adapter.close();
  }
}

function plansHaveNoRemaining(
  runDir: string,
  run: BenchmarkRun,
  plans: readonly DatasetPlan[],
  datasetsDirectory: string,
): boolean {
  return plans.every((plan) => {
    if (plan.clips.length === 0) return true;
    const dataset = plan.dataset as DatasetId;
    const result = run.results[dataset];
    if (!result) return false;
    const storedPlan = readRunPlan(planPath(runDir, dataset), run.runId);
    if (!storedPlan) return false;
    const completed = new Set(
      result.samples.map((sample) => sampleClipId(sample, datasetsDirectory)),
    );
    return sessionSelection(storedPlan, completed).remaining.length === 0;
  });
}

/**
 * Finish run artifacts in recoverable order: v2 records first, v1 completion marker last.
 * Re-running `--resume` repeats these atomic writes, repairing any crash between them.
 */
export function finalizeRunArtifacts(
  runDir: string,
  run: BenchmarkRun,
  plans: readonly DatasetPlan[],
  manifests: ReadonlyMap<DatasetId, ManifestEntry[]>,
  datasetsDirectory: string,
): void {
  run.completedAt ??= new Date().toISOString();
  for (const plan of plans) {
    const dataset = plan.dataset as DatasetId;
    const result = run.results[dataset];
    const entries = manifests.get(dataset);
    if (!result || !entries) continue;
    const runPlan = readRunPlan(planPath(runDir, dataset), run.runId);
    if (!runPlan) {
      throw new Error(`Cannot complete ${run.runId}/${dataset}: immutable Run Plan is missing.`);
    }
    saveV2(runDir, dataset, runPlan, run, result.samples, "completed", datasetsDirectory);
  }
  saveCodictateResults(runDir, run);
  run.status = "completed";
  saveRun(runDir, run);
  deleteCheckpoint(runDir);
}

/**
 * The run directory `--resume <runId|runDir>` names.
 *
 * A path wins over a run id, so the `--resume results/<timestamp>_<name>` shape the
 * README has always documented keeps working; a bare id is looked up under the results
 * root, which is what the orchestrator passes. Neither is guessed at: a value that
 * resolves to neither is an error naming both locations tried, because the alternative
 * is starting a *new* run under a name the operator meant as a resume.
 */
export function resolveRunDir(resultsRoot: string, value: string): string {
  const asPath = resolve(value);
  if (existsSync(join(asPath, "results.json"))) return asPath;
  const byId = join(resultsRoot, value);
  if (existsSync(join(byId, "results.json"))) return byId;
  throw new Error(
    `--resume ${value} names no run. Looked for a results.json in:\n` +
      `  ${join(asPath, "results.json")}\n` +
      `  ${join(byId, "results.json")}\n` +
      `Pass the run id or its directory. A resume never searches for the latest unfinished ` +
      `run: that search resumes the wrong one silently.`,
  );
}

/**
 * Builds the one bridge call a clip needs.
 *
 * `timeoutMs` is passed through flat, and deliberately ignores
 * `entry.audioDurationSec`. In `native/Sources/FlowBridge/main.swift` the
 * deadline is `stoppedAt.addingTimeInterval(timeoutMs)`, and `stoppedAt` is
 * stamped *after* playback and the tail have finished — so the value already
 * means "grace after dictation stops", and adding the clip duration to it
 * counts the audio twice. That mistake shipped once (77d49fc) and gave a 30s
 * clip twice the post-playback grace of a 2s clip; do not reintroduce it.
 */
export function transcribeRequest(config: RunConfig, entry: ManifestEntry): TranscriptionRequest {
  return {
    audioPath: entry.audioPath,
    deviceName: config.deviceName,
    hotkey: config.hotkey,
    leadMs: config.leadMs,
    tailMs: config.tailMs,
    timeoutMs: config.timeoutMs,
    stableMs: config.stableMs,
    pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
  };
}

/**
 * Fills in the poll interval a run recorded before the field existed.
 *
 * Those runs used the 50ms that was hardcoded in `main.swift`, so that is what goes
 * in: resuming one of them at the current 10ms would give the two halves of a single
 * run different `stopToFirstTextMs` granularity. A record that already names an
 * interval keeps it.
 */
export function withPollIntervalMs(config: RunConfig): RunConfig {
  if (typeof config.pollIntervalMs === "number") return config;
  console.log(
    `Resumed run recorded no pollIntervalMs; using the ${LEGACY_POLL_INTERVAL_MS}ms the bridge used then.`,
  );
  return { ...config, pollIntervalMs: LEGACY_POLL_INTERVAL_MS };
}

/**
 * Reads a flat `timeoutMs` out of any run record ever written here.
 *
 * Runs made while the timeout was audio-relative recorded `timeoutBudgetMs`
 * instead. That budget was always the slack granted after playback — the
 * bridge applies it from `stoppedAt` — so it carries over unchanged as the
 * flat timeout; only the extra clip duration, which was double-counting, is
 * dropped. A record holding both keeps its explicit `timeoutMs`.
 */
export function withTimeoutMs(config: RunConfig): RunConfig {
  if (typeof config.timeoutMs === "number") return config;
  if (typeof config.timeoutBudgetMs === "number") {
    console.log(
      `Resumed run recorded timeoutBudgetMs=${config.timeoutBudgetMs}; using it as the flat post-playback timeout.`,
    );
    return { ...config, timeoutMs: config.timeoutBudgetMs };
  }
  return { ...config, timeoutMs: DEFAULT_TIMEOUT_MS };
}

/**
 * Restores the checkout path that serialisation strips out, so a resumed run
 * can still locate the audio it has left to play.
 */
function withCodictatePath(config: RunConfig, checkout: string): RunConfig {
  if (config.codictatePath !== CODICTATE_PATH_PLACEHOLDER) {
    return { ...config, codictatePath: resolve(config.codictatePath) };
  }
  return { ...config, codictatePath: checkout };
}

/** How the operator expressed the depth they want, as a value the planner can use. */
export function depthRequest(config: RunConfig): DepthRequest {
  if (typeof config.to === "number") return { kind: "target", to: config.to };
  return { kind: "delta", samples: config.samples ?? DEFAULT_SAMPLES };
}

/**
 * Works out which consumable clips this session should measure, per dataset.
 *
 * Deliberately does not throw when a dataset has fewer clips left than were asked
 * for. It used to: `buildPlan` rejected the whole run if any one dataset was short,
 * which would abort an overnight command that could still have done useful work on
 * the other four datasets. Exhaustion now truncates that dataset's range, is logged
 * loudly, is recorded as the depth actually reached, and the run continues. Nothing
 * ever wraps around and re-uses a clip.
 *
 * It does throw on a fingerprint mismatch, because then every stored offset is
 * meaningless. See `ManifestFingerprintMismatch`.
 *
 * `fromIndex` is `--from N`, and it replaces the cursor as the start for every
 * dataset in this run. Its bound cannot be checked at parse time — it depends on how
 * many consumable clips the selected datasets actually hold — so it is checked here,
 * before a clip runs and before Flow is touched.
 */
function buildPlan(
  run: BenchmarkRun,
  resultsRoot: string,
  fromIndex?: number,
  /** Filled in with the manifests this plan was built from, so main() can reuse them. */
  manifests = new Map<DatasetId, ManifestEntry[]>(),
): DatasetPlan[] {
  const config = run.config;
  const datasetsDir = datasetsRoot(config.codictatePath);
  if (!existsSync(datasetsDir)) throw new Error(`Codictate benchmark data missing: ${datasetsDir}`);

  manifests.clear();
  const fingerprints = new Map<string, { fingerprint: string; entryCount: number }>();
  for (const dataset of config.datasets) {
    const entries = buildManifest(datasetsDir, dataset);
    manifests.set(dataset, entries);
    fingerprints.set(dataset, {
      fingerprint: manifestFingerprint(entries),
      entryCount: entries.length,
    });
  }

  if (fromIndex !== undefined) {
    const counts = new Map(
      [...manifests].map(([dataset, entries]) => [dataset, consumableEntries(entries).length]),
    );
    const error = fromIndexError(fromIndex, counts);
    if (error) throw new Error(error);
  }

  const records = scanRunRecords(resultsRoot, { productId: run.product.id });
  const cursors = deriveCursors(records, fingerprints, datasetsDir);
  const request = depthRequest(config);

  // A resumed run keeps the range it recorded rather than recomputing one from the
  // cursor: its own finished clips have already advanced that cursor, so replanning
  // would step past them and leave a hole in the middle of the run.
  const conflicts: FingerprintConflict[] = [];
  const plans: DatasetPlan[] = [];
  for (const [dataset, entries] of manifests) {
    const recorded = run.results[dataset]?.selection;
    const current = fingerprints.get(dataset)!;
    if (!recorded) {
      const plan = planDataset(dataset, entries, cursors.get(dataset) ?? 0, request, fromIndex);
      // Defect 3, second half. The cursor no longer counts an unfinished run's depth,
      // which is correct and on its own makes a *new* run start on clips an interrupted
      // one is still working through. Blocked rather than merged: two processes
      // measuring one clip write two measurements of it, and the newest-wins rule in
      // `src/contract/aggregation.ts` would then pick a winner by timestamp — a coin
      // flip dressed as a policy. The operator has the information to choose, and the
      // message hands them the run id to choose with.
      assertNoOverlappingIncompleteRun(
        { orderedClipIds: plan.clips.map((entry) => entry.clipId) },
        incompleteRunsFor(records, dataset, entries, { excludeRunId: run.runId }),
      );
      plans.push(plan);
      continue;
    }
    if (recorded.manifestFingerprint !== current.fingerprint) {
      conflicts.push({
        dataset,
        runId: run.runId,
        recordedFingerprint: recorded.manifestFingerprint,
        recordedEndIndex: recorded.endIndex,
        currentFingerprint: current.fingerprint,
        currentEntryCount: current.entryCount,
      });
      continue;
    }
    plans.push(resumePlan(dataset, entries, recorded));
  }
  if (conflicts.length > 0) throw new ManifestFingerprintMismatch(conflicts, datasetsDir);
  return plans;
}

/** One slot in a session's clip list, and whether it is played. */
export interface PlaylistSlot {
  entry: ManifestEntry;
  /** Position in the session's clip list, warmups included. */
  index: number;
  warmup: boolean;
  /** `false` only for a scored clip already measured. Always `true` for a warmup. */
  play: boolean;
}

/**
 * What a session plays, slot by slot: the reserved warmups, then the scored clips that
 * are still outstanding.
 *
 * Extracted from the run loop so the rule can be tested without an adapter, because the
 * rule is defect 6 and it is one line wide. **A warmup is always played and a scored
 * clip is played only if it is still in `remaining`**, and the `warmup` half is not
 * redundant: `remaining` holds scored clipIds only - warmups are on the plan's separate
 * `warmupClipIds` list and are deliberately absent from `orderedClipIds`, so
 * `remaining.has(warmupClipId)` is `false` for **every** warmup. Drop the warmup guard
 * and the completed-ID filter silently swallows all three of them, which is defect 6
 * verbatim: a resumed session's first real clip becomes its warmup and the model is
 * measured stone cold, with no signal anywhere.
 *
 * The warmup slots are the head of the list because `sessionEntries` builds
 * `[...plan.warmups, ...plan.clips]`, and the boundary is counted from the plan's own
 * warmup list rather than from `WARMUP_COUNT` so a resumed run replays the clips *it*
 * warmed on even if the Warmup Reservation constant changes underneath it.
 *
 * Mirrors `src/contract/selection.ts::resumeSelection`.
 */
export function sessionPlaylist(
  entries: readonly ManifestEntry[],
  warmupCount: number,
  remaining: ReadonlySet<string>,
): PlaylistSlot[] {
  return entries.map((entry, index) => {
    const warmup = index < warmupCount;
    return { entry, index, warmup, play: warmup || remaining.has(entry.clipId) };
  });
}

/**
 * The canonical `clipId` of a sample that may predate the field.
 *
 * A record written before 2026-09-04 has no `clipId`, but its `audioPath` already *is*
 * the canonical string: `portableAudioPath` writes
 * `fleurs/da_dk/audio/test/<hash>.wav` into every committed record, and SPEC §1 picked
 * that spelling precisely because it already existed there. So the fallback re-derives
 * rather than guesses, and the identity conversion is the **throwing**
 * `clipIdFromAbsoluteAudioPath` / `clipIdFromRelativeAudioPath` rather than
 * `portableAudioPath` itself: that function falls back to `basename` for a path it
 * cannot make relative, which is right for a portable record and catastrophic as
 * identity — a bare file name would pool one clip as two (SPEC addendum §K).
 *
 * In-memory samples carry absolute paths, because the runner has to open the WAV
 * files; samples read back off disk carry the relative ones. Both are handled.
 */
export function sampleClipId(
  sample: { clipId?: string; audioPath: string },
  datasetsDirectory: string,
): string {
  if (sample.clipId) return sample.clipId;
  return isAbsolute(sample.audioPath)
    ? clipIdFromAbsoluteAudioPath(sample.audioPath, datasetsDirectory)
    : clipIdFromRelativeAudioPath(sample.audioPath);
}

/**
 * One `SampleResult` as the contract's per-Sample measurement.
 *
 * `responseMs` is `stopToLastTextChangeMs` and nothing else may stand in for it.
 * `stopToStableTextMs` is the legacy fallback and it **includes** the 750 ms stability
 * confirmation, so a sample that only has that number is not a v2 speed measurement —
 * which is exactly what the absence of `hotkeyEdge`/`timingClock` in its `overhead`
 * tells `src/contract/timing.ts::speedCompatible`.
 *
 * The provenance stamps are passed through **as recorded and never defaulted**. A
 * `hotkeyEdge: "keydown"` invented here to satisfy a type would tell the pooling code
 * that a pre-fix clip was measured properly, and the ~85 ms of optimism that filter
 * exists to remove would be back in the published comparison.
 */
export function sampleMeasurementFor(
  sample: SampleResult,
  datasetsDirectory: string,
): SampleMeasurementV2 {
  const characterErrors = sample.cer
    ? sample.cer.substitutions + sample.cer.insertions + sample.cer.deletions
    : 0;
  return {
    clipId: sampleClipId(sample, datasetsDirectory),
    ...(sample.sentenceId === undefined ? {} : { sentenceId: sample.sentenceId }),
    audioDurationSec: sample.audioDurationSec,
    responseMs: sample.stopToLastTextChangeMs ?? sample.stopToStableTextMs ?? null,
    status: sample.status,
    wordErrors: sample.wer.substitutions + sample.wer.insertions + sample.wer.deletions,
    referenceWords: sample.wer.refWords,
    charErrors: characterErrors,
    referenceChars: sample.cer?.refChars ?? 0,
    isWarmup: sample.warmup,
    overhead: {
      // This harness presses a global shortcut and watches an NSTextView. There is no
      // other regime it could be in, so the discriminator is unconditional.
      timingRegime: "ui-observed-paste",
      ...(sample.hotkeyEdge == null ? {} : { hotkeyEdge: sample.hotkeyEdge }),
      ...(sample.timingClock == null ? {} : { timingClock: sample.timingClock }),
      ...(sample.textChangeSource == null ? {} : { observation: sample.textChangeSource }),
      ...(sample.textChangeBiasMs == null ? {} : { textChangeBiasMs: sample.textChangeBiasMs }),
      ...(sample.textChangeCount == null ? {} : { textChangeCount: sample.textChangeCount }),
      ...(sample.stabilityDelayMs == null ? {} : { stabilityDelayMs: sample.stabilityDelayMs }),
      ...(sample.startToStopMs == null ? {} : { startToStopMs: sample.startToStopMs }),
      ...(sample.stopToStableTextMs == null ? {} : { stopToStableTextMs: sample.stopToStableTextMs }),
      ...(sample.stopToFirstTextMs == null ? {} : { stopToFirstTextMs: sample.stopToFirstTextMs }),
      ...(sample.outputDeviceRestoreMs == null
        ? {}
        : { outputDeviceRestoreMs: sample.outputDeviceRestoreMs }),
    },
    ...(sample.diagnostic === undefined ? {} : { failureDiagnostic: sample.diagnostic }),
  };
}

/** Checkpoint one dataset's v2 run record. Atomic, fsynced, after every scored clip. */
function saveV2(
  runDir: string,
  dataset: DatasetId,
  runPlan: RunPlan,
  run: BenchmarkRun,
  samples: readonly SampleResult[],
  status: "completed" | "incomplete",
  datasetsDirectory: string,
): void {
  saveRunRecordV2(
    runDir,
    dataset,
    buildRunRecordV2({
      plan: runPlan,
      status,
      startedAt: run.createdAt,
      completedAt: status === "completed" ? (run.completedAt ?? new Date().toISOString()) : null,
      samples: samples.map((sample) => sampleMeasurementFor(sample, datasetsDirectory)),
      ...(run.config.configurationNote ? { description: run.config.configurationNote } : {}),
    }),
  );
}

/**
 * How much of this dataset's planned range is already captured.
 *
 * Counted as the leading run of planned clips present in the run directory rather
 * than as "samples that are not warmups", so the recorded `endIndex` stays the
 * honest contiguous depth even in a run directory that also holds samples from
 * outside this range.
 */
export function measuredPrefix(plan: DatasetPlan, captured: ReadonlySet<string>): number {
  let measured = 0;
  // On `clipId`, not on the label `id`: a FLEURS sentence id repeats, so a prefix
  // counted on it advanced for free over every clip that shared a sentence with an
  // earlier one and recorded a depth nothing had transcribed (defect 1).
  while (measured < plan.clips.length && captured.has(plan.clips[measured].clipId)) measured += 1;
  return measured;
}

function aggregate(samples: SampleResult[]): DatasetResult["aggregate"] {
  const scored = samples.filter((sample) => !sample.warmup);
  const substitutions = sum(scored, (sample) => sample.wer.substitutions);
  const insertions = sum(scored, (sample) => sample.wer.insertions);
  const deletions = sum(scored, (sample) => sample.wer.deletions);
  const referenceWords = sum(scored, (sample) => sample.wer.refWords);
  const cerSamples = scored.filter((sample) => sample.cer !== undefined);
  const characterErrors = sum(
    cerSamples,
    (sample) => sample.cer!.substitutions + sample.cer!.insertions + sample.cer!.deletions,
  );
  const referenceChars = sum(cerSamples, (sample) => sample.cer!.refChars);
  // Swift handoff item 3. `stopToStableTextMs` **includes** the 750 ms stability
  // confirmation plus up to one poll of noticing it, so it is not a response time and
  // a mean of it is not a mean response. `stopToLastTextChangeMs` is the raw stop-edge
  // to last-text-change stamp and is the response metric; the fallback keeps runs
  // recorded before 2026-09-04 readable, and those are exactly the runs
  // `speedCompatible` keeps out of every pooled ratio.
  const responses = scored
    .map((sample) => sample.stopToLastTextChangeMs ?? sample.stopToStableTextMs)
    .filter((value): value is number => value !== null && value !== undefined);
  const stableLatencies = scored
    .map((sample) => sample.stopToStableTextMs)
    .filter((value): value is number => value !== null);
  return {
    wer: referenceWords === 0 ? 0 : (substitutions + insertions + deletions) / referenceWords,
    substitutions,
    insertions,
    deletions,
    referenceWords,
    cer: referenceChars === 0 ? undefined : characterErrors / referenceChars,
    characterErrors: referenceChars === 0 ? undefined : characterErrors,
    referenceChars: referenceChars === 0 ? undefined : referenceChars,
    scoredSamples: scored.length,
    failures: scored.filter((sample) => sample.status !== "ok").length,
    meanResponseMs:
      responses.length === 0 ? null : responses.reduce((a, b) => a + b, 0) / responses.length,
    meanStopToStableTextMs:
      stableLatencies.length === 0
        ? null
        : stableLatencies.reduce((a, b) => a + b, 0) / stableLatencies.length,
  };
}

function sum<T>(items: T[], select: (item: T) => number): number {
  return items.reduce((total, item) => total + select(item), 0);
}

function saveRun(runDir: string, run: BenchmarkRun): void {
  run.updatedAt = new Date().toISOString();
  writeJsonAtomically(join(runDir, "results.json"), portableRun(run));
}

function saveCheckpoint(runDir: string, run: BenchmarkRun, currentDataset?: DatasetId): void {
  writeJsonAtomically(
    join(runDir, "checkpoint.json"),
    buildCodictateCheckpoint(run, currentDataset),
  );
}

function saveCodictateResults(runDir: string, run: BenchmarkRun): void {
  writeJsonAtomically(join(runDir, "stt.json"), buildCodictateResults(run));
}

function deleteCheckpoint(runDir: string): void {
  const path = join(runDir, "checkpoint.json");
  if (existsSync(path)) unlinkSync(path);
}

/**
 * Write, flush to the platter, then rename over the target.
 *
 * The temporary file is a sibling on purpose: `rename` is only atomic within one
 * filesystem, and a temp directory can be on another. The `fsync` is what makes the
 * rename mean anything — without it a power loss can leave the directory entry
 * pointing at a file whose contents never reached the disk, which is the one failure
 * mode a checkpoint exists to survive. Best-effort, because a filesystem that refuses
 * `fsync` must not fail a run that is otherwise fine.
 *
 * Called after **every scored clip**, never batched. A 50-clip batch means a crash
 * costs up to 50 clips of real-time audio playback, and the clips it costs are
 * indistinguishable afterwards from clips that were never planned.
 */
export function writeJsonAtomically(target: string, value: unknown): void {
  const temporary = `${target}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const handle = openSync(temporary, "w");
  try {
    writeSync(handle, payload);
    try {
      fsyncSync(handle);
    } catch {
      // Some filesystems (and some CI sandboxes) refuse fsync. The rename is still
      // ordered after the write; only the power-loss guarantee is lost.
    }
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, target);
}

function osVersion(): string {
  try {
    const result = Bun.spawnSync(["sw_vers", "-productVersion"]);
    const version = new TextDecoder().decode(result.stdout).trim();
    return version || release();
  } catch {
    return release();
  }
}

/** Clips a dataset actually plays this session: the warmup replays, then the range. */
function sessionEntries(plan: DatasetPlan): ManifestEntry[] {
  return plan.clips.length === 0 ? [] : [...plan.warmups, ...plan.clips];
}

/**
 * Prints the plan preview, always, before a single clip runs.
 *
 * `--samples` is a delta, so the same command run twice measures twice as many
 * clips. An operator has to be able to read off exactly which consumable clips a
 * command is about to spend, per dataset, before it spends them.
 *
 * `--from` raises the stakes: it is the only flag that can re-spend clips already
 * measured, so the header names it and every per-dataset line that rewinds says so.
 */
function printPlan(
  run: BenchmarkRun,
  runDir: string,
  plans: DatasetPlan[],
  fromIndex?: number,
): void {
  const entries = plans.flatMap(sessionEntries);
  const scored = plans.reduce((total, plan) => total + plan.clips.length, 0);
  const warmupReplays = plans.filter((plan) => plan.clips.length > 0).length * WARMUP_COUNT;
  const audioSeconds = entries.reduce((total, entry) => total + entry.audioDurationSec, 0);
  const request = depthRequest(run.config);
  console.log(`Run:       ${run.runId}`);
  console.log(`Product:   Wispr Flow`);
  console.log(`Datasets:  ${plans.map((plan) => plan.dataset).join(", ")}`);
  console.log(
    request.kind === "delta"
      ? `Depth:     --samples ${request.samples} (delta: ${request.samples} more per dataset, from the cursor)`
      : `Depth:     --to ${request.to} (target depth: run until ${request.to} per dataset are measured)`,
  );
  if (fromIndex !== undefined) {
    console.log(
      `From:      --from ${fromIndex} (explicit start into the consumable range; the cursor is ignored for this run only)`,
    );
    const rewinds = plans.filter((plan) => plan.rewind);
    if (rewinds.length > 0) {
      console.log(
        `           REWIND: ${rewinds.length} dataset${rewinds.length === 1 ? "" : "s"} will re-measure clips already measured. Nothing is deleted and no cursor moves backwards; the same clips are simply run again.`,
      );
    }
  }
  console.log(`Warmups:   ${WARMUP_COUNT} per dataset, replayed unscored, never consumed`);
  console.log(`Clips:     ${entries.length} (${warmupReplays} warmup replays + ${scored} scored)`);
  console.log(`Audio:     ${(audioSeconds / 60).toFixed(1)} minutes at 1.0×`);
  console.log(`Input:     ${run.config.deviceName}`);
  console.log(
    `Hotkey:    key code ${run.config.hotkey.keyCode} + ${run.config.hotkey.modifiers.join("+")} ` +
      `(set Wispr Flow's Hands-free shortcut to match; nothing here can verify it)`,
  );
  console.log(`Timeout:   ${run.config.timeoutMs}ms after dictation stops (flat; same for every clip)`);
  console.log(
    `Polling:   every ${run.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS}ms (fallback only; ` +
      `the bridge stamps text changes from the receiver's NSTextStorage notification and reports ` +
      `its own bias per clip as textChangeBiasMs — 0 on that path, one whole interval when it ` +
      `fell back to polling)`,
  );
  console.log(`Output:    ${runDir}`);
  console.log("Plan:");
  for (const plan of plans) console.log(`  ${formatPlanLine(plan)}`);
}

function parseArgs(args: string[]): CliOptions {
  const config: RunConfig = {
    codictatePath: resolve(import.meta.dir, "../../codictate"),
    datasets: [...DATASET_IDS],
    samples: DEFAULT_SAMPLES,
    deviceName: "BlackHole 2ch",
    // Option+Z. See the `hotkey` field on `RunConfig`: `parseHotkey("option+z")` is the
    // same derivation `--flow-hotkey` uses, so the default cannot drift from the flag.
    hotkey: (({ keyCode, modifiers }) => ({ keyCode, modifiers }))(
      parseHotkey(DEFAULT_FLOW_HOTKEY),
    ),
    leadMs: 500,
    tailMs: 500,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stableMs: 750,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    configurationNote: "",
  };
  const options: CliOptions = { dryRun: false, config };
  let sawSamples = false;
  let sawTo = false;

  // The resume refusals run **before** flag parsing, not after, because several of the
  // thirteen are flags this harness does not accept at all (`--seed`, `--smoke`,
  // `--limit`, Codictate's `--languages` and `--splits`). Parsed first, the operator
  // would get "Unknown flag: --seed" — technically true and useless, since the real
  // problem is that they asked a resume to change its selection. Checked on the argv
  // tokens rather than on parsed options for the reason
  // `src/contract/selection.ts::assertResumeFlags` gives: a parser fills in defaults,
  // and once it has, "the operator passed --samples 200" is indistinguishable from
  // "--samples defaulted to 200".
  // `--resume X` and `--resume=X` both. Matched on the flag *name* rather than on an
  // exact token, because the `=` form skipped this block entirely and then failed later
  // with a message about something else - safe, but a misleading diagnosis.
  const resumeIndex = args.findIndex(
    (token) => token === "--resume" || token.startsWith("--resume="),
  );
  if (resumeIndex !== -1) {
    const resumeToken = args[resumeIndex];
    const resumeValue = resumeToken.includes("=")
      ? resumeToken.slice(resumeToken.indexOf("=") + 1)
      : args[resumeIndex + 1];
    if (args.some((token) => token === "--from" || token.startsWith("--from="))) {
      // Kept as its own message because it says more than the generic one: it explains
      // that the resumed run already recorded the range it is measuring.
      throw new Error(
        "Use --from or --resume, not both. A resumed run already recorded the range it was " +
          "measuring and carries the clips it finished from that range; rewinding it to a " +
          "different start would file those clips against a range they do not belong to. " +
          "Finish or abandon that run, then start a new one with --from.",
      );
    }
    assertResumeFlags(args, resumeValue);
  }

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = () => {
      const next = args[++index];
      if (!next) throw new Error(`${flag} requires a value`);
      return next;
    };
    switch (flag) {
      case "--name": options.name = value(); break;
      case "--resume": options.resume = value(); break;
      case "--out": options.out = value(); break;
      // Accepted and ignored for selection: the orchestrator passes it on every
      // invocation, including resuming ones, so it names the batch a stage belongs to
      // rather than the clips the stage measures.
      case "--batch": config.batchId = value(); break;
      case "--dry-run": options.dryRun = true; break;
      case "--codictate": config.codictatePath = resolve(value()); break;
      case "--datasets": config.datasets = parseDatasets(value()); break;
      case "--samples": config.samples = positiveInteger(value(), flag); sawSamples = true; break;
      case "--to": config.to = positiveInteger(value(), flag); sawTo = true; break;
      case "--from": options.from = nonNegativeInteger(value(), flag); break;
      case "--timeout-ms": config.timeoutMs = positiveInteger(value(), flag); break;
      case "--poll-interval-ms": config.pollIntervalMs = positiveInteger(value(), flag); break;
      case "--device": config.deviceName = value(); break;
      // `option+z`, `option+space`, ... parsed rather than taken as a raw key code,
      // because a key code is unreadable and the cost of getting it wrong is a whole
      // night of timeouts. See `src/publication.ts::parseHotkey`, which is the one
      // implementation both entry points use.
      case "--flow-hotkey": {
        const hotkey = parseHotkey(value());
        config.hotkey = { keyCode: hotkey.keyCode, modifiers: hotkey.modifiers };
        break;
      }
      // Two spellings of one field, so the same command shape works in this harness and
      // in Codictate's `bench:stt`, which calls the free-text note `--description`. Both
      // write `config.configurationNote`; the recorded field name is unchanged.
      case "--configuration-note":
      case "--description": config.configurationNote = value(); break;
      default: throw new Error(`Unknown flag: ${flag}`);
    }
  }
  if (sawSamples && sawTo) {
    throw new Error(
      "Use --samples (a delta: N more from the cursor) or --to (a target depth), not both",
    );
  }
  // `--to` supersedes the default delta; leaving both set would make the record
  // claim a delta the run never used.
  if (sawTo) delete config.samples;
  if (options.from !== undefined && !sawSamples && !sawTo) {
    throw new Error(
      "--from needs a depth flag. --from N --samples M measures M clips starting at N; " +
        "--from N --to M measures from N up to depth M. --from on its own names a start and " +
        `no end, and falling back to the default --samples ${DEFAULT_SAMPLES} would pick a ` +
        "depth nobody asked for on the one path that re-spends clips already measured.",
    );
  }
  if (options.from !== undefined && options.resume) {
    throw new Error(
      "Use --from or --resume, not both. A resumed run already recorded the range it was " +
        "measuring and carries the clips it finished from that range; rewinding it to a " +
        "different start would file those clips against a range they do not belong to. " +
        "Finish or abandon that run, then start a new one with --from.",
    );
  }
  if (options.resume && options.name) throw new Error("Use --resume or --name, not both");
  return options;
}

function parseDatasets(value: string): DatasetId[] {
  const values = value.split(",").filter(Boolean);
  for (const dataset of values) {
    if (!(DATASET_IDS as readonly string[]).includes(dataset)) {
      throw new Error(`Unknown dataset "${dataset}". Expected: ${DATASET_IDS.join(", ")}`);
    }
  }
  if (values.length === 0) throw new Error("--datasets cannot be empty");
  return values as DatasetId[];
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

/**
 * An index rather than a count, so zero is legal and negative is not.
 *
 * `--from 0` is the whole point of the flag — re-measure from the first consumable
 * clip — so it cannot share `positiveInteger` with the depth flags.
 */
function nonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `${flag} must be a non-negative integer index into the consumable range (0 is the first clip after the ${WARMUP_COUNT} reserved warmups)`,
    );
  }
  return parsed;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
}

function slug(value: string): string {
  const result = basename(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!result) throw new Error("--name must contain letters or numbers");
  return result;
}

function formatMs(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value)}ms`;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
