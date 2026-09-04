import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { arch, cpus, platform, release, totalmem } from "node:os";
import {
  MINIMUM_VIRTUAL_MIC_FLOW_VERSION,
  supportsVirtualMicrophone,
  WisprFlowAdapter,
} from "./adapters/wispr-flow";
import { buildManifest } from "./manifest";
import { computeCer, computeWer, type CerResult, type WerResult } from "./scoring";
import { DATASET_IDS, type DatasetId, type ManifestEntry, type ProductMetadata } from "./types";
import { buildCodictateCheckpoint, buildCodictateResults } from "./codictate-compat";

const WARMUP_COUNT = 3;

interface RunConfig {
  codictatePath: string;
  datasets: DatasetId[];
  samples: number;
  deviceName: string;
  hotkey: { keyCode: number; modifiers: ["option"] };
  leadMs: number;
  tailMs: number;
  timeoutMs: number;
  stableMs: number;
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
  diagnostic?: string;
}

interface DatasetResult {
  samples: SampleResult[];
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

  const plan = buildPlan(run.config);
  printPlan(run, runDir, plan);
  if (options.dryRun) return;

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

    for (const [dataset, entries] of plan) {
      const result = (run.results[dataset] ??= { samples: [] });
      const completed = new Set(result.samples.map((sample) => sample.id));
      console.log(`\n[${dataset}] ${entries.length} clips`);

      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (completed.has(entry.id)) {
          console.log(`  ${index + 1}/${entries.length} ${entry.id} already captured`);
          continue;
        }

        const warmup = index < WARMUP_COUNT;
        process.stdout.write(`  ${index + 1}/${entries.length} ${entry.id}${warmup ? " (warmup)" : ""} ... `);
        const startedAt = performance.now();
        const transcription = await adapter.transcribe({
          audioPath: entry.audioPath,
          deviceName: run.config.deviceName,
          hotkey: run.config.hotkey,
          leadMs: run.config.leadMs,
          tailMs: run.config.tailMs,
          timeoutMs: run.config.timeoutMs,
          stableMs: run.config.stableMs,
        });
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
          diagnostic: transcription.diagnostic,
        });
        result.aggregate = aggregate(result.samples);
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

function buildPlan(config: RunConfig): Map<DatasetId, ManifestEntry[]> {
  const datasetsDir = join(config.codictatePath, "benchmarks", "datasets");
  if (!existsSync(datasetsDir)) throw new Error(`Codictate benchmark data missing: ${datasetsDir}`);
  const plan = new Map<DatasetId, ManifestEntry[]>();
  for (const dataset of config.datasets) {
    const entries = buildManifest(datasetsDir, dataset).slice(0, config.samples);
    if (entries.length < config.samples) {
      throw new Error(`${dataset} has ${entries.length} clips; requested ${config.samples}`);
    }
    plan.set(dataset, entries);
  }
  return plan;
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
  writeJsonAtomically(join(runDir, "results.json"), run);
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

function printPlan(
  run: BenchmarkRun,
  runDir: string,
  plan: Map<DatasetId, ManifestEntry[]>,
): void {
  const entries = [...plan.values()].flat();
  const audioSeconds = entries.reduce((total, entry) => total + entry.audioDurationSec, 0);
  console.log(`Run:       ${run.runId}`);
  console.log(`Product:   Wispr Flow`);
  console.log(`Datasets:  ${[...plan.keys()].join(", ")}`);
  console.log(`Clips:     ${entries.length} (${WARMUP_COUNT} warmups per dataset)`);
  console.log(`Audio:     ${(audioSeconds / 60).toFixed(1)} minutes at 1.0×`);
  console.log(`Input:     ${run.config.deviceName}`);
  console.log(`Output:    ${runDir}`);
}

function parseArgs(args: string[]): CliOptions {
  const config: RunConfig = {
    codictatePath: resolve(import.meta.dir, "../../codictate"),
    datasets: [...DATASET_IDS],
    samples: 20,
    deviceName: "BlackHole 2ch",
    hotkey: { keyCode: 49, modifiers: ["option"] },
    leadMs: 500,
    tailMs: 500,
    timeoutMs: 45_000,
    stableMs: 750,
    configurationNote: "",
  };
  const options: CliOptions = { dryRun: false, config };

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
      case "--samples": config.samples = positiveInteger(value(), flag); break;
      case "--device": config.deviceName = value(); break;
      case "--configuration-note": config.configurationNote = value(); break;
      default: throw new Error(`Unknown flag: ${flag}`);
    }
  }
  if (config.samples <= WARMUP_COUNT) throw new Error(`--samples must be greater than ${WARMUP_COUNT}`);
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
