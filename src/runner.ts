import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { arch, cpus, platform, release, totalmem } from "node:os";
import {
  MINIMUM_VIRTUAL_MIC_FLOW_VERSION,
  supportsVirtualMicrophone,
  WisprFlowAdapter,
} from "./adapters/wispr-flow";
import { buildManifest } from "./manifest";
import {
  deriveCursors,
  formatPlanLine,
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

const DEFAULT_TIMEOUT_MS = 45_000;

/**
 * Consumable clips `--samples` runs when the flag is omitted. A delta, not a depth:
 * see `DepthRequest`.
 */
const DEFAULT_SAMPLES = 20;

/**
 * How often the bridge re-reads the receiver window while waiting for text.
 *
 * This is the granularity of `stopToFirstTextMs`: text that lands between two polls
 * is not seen until the later one, so the measurement carries a mean upward bias of
 * half an interval. It was 50ms and hardcoded in the bridge, worth a mean +25ms;
 * 10ms cuts that to +5ms while still sleeping between reads rather than spinning.
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
  hotkey: { keyCode: number; modifiers: ["option"] };
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

interface SampleResult {
  id: string;
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
  resume?: string;
  dryRun: boolean;
  config: RunConfig;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const resultsRoot = resolve(import.meta.dir, "../results");
  let run: BenchmarkRun;
  let runDir: string;

  if (options.resume) {
    runDir = resolve(options.resume);
    run = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8")) as BenchmarkRun;
    if (run.status === "completed") throw new Error(`Run already completed: ${runDir}`);
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

  const plans = buildPlan(run, resultsRoot);
  printPlan(run, runDir, plans);
  if (options.dryRun) return;
  if (plans.every((plan) => plan.clips.length === 0)) {
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
      const entries = sessionEntries(plan);
      const completed = new Set(result.samples.map((sample) => sample.id));
      if (!result.selection && result.samples.some((sample) => !sample.warmup)) {
        throw new Error(
          `${dataset} in ${runDir} holds scored samples but no recorded range, so this run ` +
            `predates consumable ranges. Backfill it with scripts/backfill-selection.ts before ` +
            `resuming, or start a new run; continuing would mix two selection schemes in one ` +
            `dataset and record a depth neither of them reached.`,
        );
      }
      result.selection = selectionFor(plan, measuredPrefix(plan, completed));
      saveRun(runDir, run);
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

      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (completed.has(entry.id)) {
          console.log(`  ${index + 1}/${entries.length} ${entry.id} already captured`);
          continue;
        }

        const warmup = index < WARMUP_COUNT;
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
          diagnostic: transcription.diagnostic,
        });
        result.aggregate = aggregate(result.samples);
        completed.add(entry.id);
        // Kept honest after every clip, so a run that dies halfway advances the
        // cursor by the clips it finished and not by the clips it intended.
        result.selection = selectionFor(plan, measuredPrefix(plan, completed));
        saveRun(runDir, run);
        saveCheckpoint(runDir, run, dataset);
        console.log(
          `${transcription.status}; WER ${(wer.wer * 100).toFixed(1)}%; stop→text ${formatMs(transcription.stopToStableTextMs)}`,
        );
      }
    }

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    saveCodictateResults(runDir, run);
    saveRun(runDir, run);
    deleteCheckpoint(runDir);
    console.log(`\nCompleted: ${join(runDir, "results.json")}`);
    console.log(`Comparable: ${join(runDir, "stt.json")}`);
  } finally {
    await adapter.close();
  }
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
 */
function buildPlan(run: BenchmarkRun, resultsRoot: string): DatasetPlan[] {
  const config = run.config;
  const datasetsDir = datasetsRoot(config.codictatePath);
  if (!existsSync(datasetsDir)) throw new Error(`Codictate benchmark data missing: ${datasetsDir}`);

  const manifests = new Map<DatasetId, ManifestEntry[]>();
  const fingerprints = new Map<string, { fingerprint: string; entryCount: number }>();
  for (const dataset of config.datasets) {
    const entries = buildManifest(datasetsDir, dataset);
    manifests.set(dataset, entries);
    fingerprints.set(dataset, {
      fingerprint: manifestFingerprint(entries),
      entryCount: entries.length,
    });
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
      plans.push(planDataset(dataset, entries, cursors.get(dataset) ?? 0, request));
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

/**
 * How much of this dataset's planned range is already captured.
 *
 * Counted as the leading run of planned clips present in the run directory rather
 * than as "samples that are not warmups", so the recorded `endIndex` stays the
 * honest contiguous depth even in a run directory that also holds samples from
 * outside this range.
 */
function measuredPrefix(plan: DatasetPlan, captured: ReadonlySet<string>): number {
  let measured = 0;
  while (measured < plan.clips.length && captured.has(plan.clips[measured].id)) measured += 1;
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
  const latencies = scored
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
    meanStopToStableTextMs:
      latencies.length === 0 ? null : latencies.reduce((a, b) => a + b, 0) / latencies.length,
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

function writeJsonAtomically(target: string, value: unknown): void {
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
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
 */
function printPlan(run: BenchmarkRun, runDir: string, plans: DatasetPlan[]): void {
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
  console.log(`Warmups:   ${WARMUP_COUNT} per dataset, replayed unscored, never consumed`);
  console.log(`Clips:     ${entries.length} (${warmupReplays} warmup replays + ${scored} scored)`);
  console.log(`Audio:     ${(audioSeconds / 60).toFixed(1)} minutes at 1.0×`);
  console.log(`Input:     ${run.config.deviceName}`);
  console.log(`Timeout:   ${run.config.timeoutMs}ms after dictation stops (flat; same for every clip)`);
  console.log(`Polling:   every ${run.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS}ms (granularity of stopToFirstTextMs)`);
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
    hotkey: { keyCode: 49, modifiers: ["option"] },
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
      case "--dry-run": options.dryRun = true; break;
      case "--codictate": config.codictatePath = resolve(value()); break;
      case "--datasets": config.datasets = parseDatasets(value()); break;
      case "--samples": config.samples = positiveInteger(value(), flag); sawSamples = true; break;
      case "--to": config.to = positiveInteger(value(), flag); sawTo = true; break;
      case "--timeout-ms": config.timeoutMs = positiveInteger(value(), flag); break;
      case "--poll-interval-ms": config.pollIntervalMs = positiveInteger(value(), flag); break;
      case "--device": config.deviceName = value(); break;
      case "--configuration-note": config.configurationNote = value(); break;
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
