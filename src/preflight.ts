/**
 * Everything that has to be true before a Benchmark Run is worth starting, checked
 * before it starts.
 *
 * An overnight production batch is hours of real-time audio playback, so a check that
 * fires on clip 900 has already cost the night. Every check here therefore runs up
 * front and reports **what to do about it**, not just that it failed: a preflight that
 * says "audio device missing" and stops is one the operator has to go and read the
 * README for.
 *
 * Two kinds of check, kept apart because they cost different things:
 *
 * - **Machine checks** touch Wispr Flow, Core Audio and the Accessibility permission.
 *   They need the native bridge to be built and the product to be running, and they
 *   are the ones a `--dry-run` cannot make.
 * - **Repository checks** read the datasets directory, the models directory, the free
 *   disk and the results tree. They need nothing running and are safe in a `--dry-run`.
 *
 * `bun run preflight` prints both. `src/publication.ts` runs both before a real batch
 * and only the repository half under `--dry-run`, saying which it skipped.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  MINIMUM_VIRTUAL_MIC_FLOW_VERSION,
  supportsVirtualMicrophone,
  WisprFlowAdapter,
} from "./adapters/wispr-flow";
import { datasetsRoot } from "./portable-paths";
import { incompleteRunsFor, scanRunRecords } from "./selection";
import { buildManifest } from "./manifest";
import { DATASET_IDS, type DatasetId } from "./types";

export type CheckStatus = "ok" | "failed" | "skipped";

export interface Check {
  /** Stable identifier, so a stage record can name the check that stopped it. */
  id: string;
  label: string;
  status: CheckStatus;
  /** What was observed. One line. */
  detail: string;
  /**
   * What the operator should do about it. **Required on a failure**, because a
   * preflight message that only reports is a message the operator has to go and read
   * the README for at 2am.
   */
  remedy?: string;
}

export interface PreflightOptions {
  codictatePath: string;
  deviceName: string;
  datasets: readonly DatasetId[];
  /** Speech Models the batch will need on disk. */
  models?: readonly string[];
  /** Results root the compatibility-state check reads, and the batch writes into. */
  resultsRoot: string;
  /**
   * Further results roots to check for incomplete runs and stale checkpoints.
   *
   * The smoke chain writes into `results/smoke/<batch>/`, which is fresh every time, so
   * a check scoped to it would always pass and would tell the operator nothing about
   * the production tree they are about to spend a night on. The orchestrator passes the
   * production root here when the two differ.
   */
  alsoCheckResultsRoots?: readonly string[];
  /** Free bytes the batch needs. Defaults to 5 GB. */
  minimumFreeBytes?: number;
}

/** 5 GB: a 400-clip five-dataset batch writes tens of MB, and models are ~1 GB each. */
export const DEFAULT_MINIMUM_FREE_BYTES = 5 * 1024 * 1024 * 1024;

// -- Repository checks: no apps, no hardware, safe under --dry-run --

/**
 * The checks a `--dry-run` can honestly make.
 *
 * Deliberately does **not** build every manifest: `buildManifest` reads the RIFF header
 * of every WAV, which is 2620 file reads for `test-clean` alone. It checks that the
 * source files a manifest is built from exist, which is what actually goes wrong (a
 * half-finished `hf download`), and leaves the full build to the plan.
 */
export function repositoryChecks(options: PreflightOptions): Check[] {
  const checks: Check[] = [];
  const datasetsDir = datasetsRoot(options.codictatePath);

  checks.push(
    existsSync(datasetsDir)
      ? {
          id: "datasets-root",
          label: "Datasets directory",
          status: "ok",
          detail: datasetsDir,
        }
      : {
          id: "datasets-root",
          label: "Datasets directory",
          status: "failed",
          detail: `missing: ${datasetsDir}`,
          remedy:
            "Point --codictate at the Codictate checkout that holds benchmarks/datasets, or " +
            "download the corpora there first (benchmarks/scripts/download-fleurs.ts and the " +
            "LibriSpeech step in codictate/benchmarks/README.md).",
        },
  );

  for (const dataset of options.datasets) {
    const source = dataset.startsWith("test-")
      ? join(datasetsDir, "librispeech", dataset)
      : join(datasetsDir, "fleurs", dataset, "test.tsv");
    const audio = dataset.startsWith("test-")
      ? join(datasetsDir, "librispeech", "wav", dataset)
      : join(datasetsDir, "fleurs", dataset, "audio", "test");
    const missing = [source, audio].filter((path) => !existsSync(path));
    checks.push(
      missing.length === 0
        ? {
            id: `manifest-${dataset}`,
            label: `Manifest source: ${dataset}`,
            status: "ok",
            detail: `${countFiles(audio)} audio files under ${audio}`,
          }
        : {
            id: `manifest-${dataset}`,
            label: `Manifest source: ${dataset}`,
            status: "failed",
            detail: `missing ${missing.join(", ")}`,
            remedy:
              `Download ${dataset} into the Codictate checkout before running it, or drop it ` +
              `from this batch with --datasets. A partially downloaded corpus is worse than a ` +
              `missing one: the manifest would build from the clips that happen to be there, ` +
              `the ordering would change, and every recorded cursor offset would then name ` +
              `different clips.`,
          },
    );
  }

  for (const model of options.models ?? []) {
    const found = findModelFile(options.codictatePath, model);
    checks.push(
      found
        ? { id: `model-${model}`, label: `Speech Model: ${model}`, status: "ok", detail: found }
        : {
            id: `model-${model}`,
            label: `Speech Model: ${model}`,
            status: "failed",
            detail:
              `no model file matching "${model}". Looked in: ` +
              modelDirectories(options.codictatePath).join(", "),
            remedy:
              `Let Codictate download it once with \`bun run bench:stt -- --models ${model} ` +
              `--samples 1 --name model-warmup --description "download only"\`, or drop the ` +
              `model from this batch with --models. This orchestrator never downloads and ` +
              `never offloads: a batch that fetched a gigabyte mid-run would charge the ` +
              `download to the first clip's wall time.`,
          },
    );
  }

  const free = freeBytes(options.resultsRoot);
  const minimum = options.minimumFreeBytes ?? DEFAULT_MINIMUM_FREE_BYTES;
  checks.push(
    free === null
      ? {
          id: "free-disk",
          label: "Free disk",
          status: "skipped",
          detail: "could not be read on this platform",
        }
      : free >= minimum
        ? {
            id: "free-disk",
            label: "Free disk",
            status: "ok",
            detail: `${gib(free)} GiB free, ${gib(minimum)} GiB required`,
          }
        : {
            id: "free-disk",
            label: "Free disk",
            status: "failed",
            detail: `${gib(free)} GiB free, ${gib(minimum)} GiB required`,
            remedy:
              "Free space before starting. A batch that fills the disk mid-run leaves a " +
              "half-written checkpoint, and the run then has to be discarded rather than " +
              "resumed.",
          },
  );

  checks.push(compatibilityStateCheck(options));
  return checks;
}

/**
 * Whether the results tree is in a state a new batch may be started from.
 *
 * Two things go wrong here and both are silent. An **incomplete run** overlapping the
 * batch's range means two processes will measure the same clips and the pooled winner
 * will be decided by a timestamp (defect 3). A leftover **`.tmp` file** means a
 * previous process died between the write and the rename, so the record beside it is
 * one clip stale — harmless in itself, and worth saying out loud before an operator
 * spends a night on top of it.
 */
function compatibilityStateCheck(options: PreflightOptions): Check {
  const datasetsDir = datasetsRoot(options.codictatePath);
  const roots = [options.resultsRoot, ...(options.alsoCheckResultsRoots ?? [])].filter(
    (root, index, all) => existsSync(root) && all.indexOf(root) === index,
  );
  if (!existsSync(datasetsDir) || roots.length === 0) {
    return {
      id: "compatibility-state",
      label: "Compatibility state",
      status: "skipped",
      detail:
        roots.length === 0
          ? `no results tree yet at ${options.resultsRoot}: nothing has been measured here, so ` +
            `there is nothing to conflict with`
          : `no datasets at ${datasetsDir} to compare the recorded offsets against`,
    };
  }

  const incomplete: string[] = [];
  const stale: string[] = [];
  let recordCount = 0;
  for (const root of roots) {
    const records = scanRunRecords(root, { productId: "wispr-flow" });
    recordCount += records.length;
    for (const dataset of options.datasets) {
      let entries;
      try {
        entries = buildManifest(datasetsDir, dataset);
      } catch {
        continue;
      }
      for (const run of incompleteRunsFor(records, dataset, entries)) {
        incomplete.push(`${run.runId} (${dataset}, ${run.orderedClipIds.length} clips)`);
      }
    }
    stale.push(...staleTemporaryFiles(root));
  }

  if (incomplete.length === 0 && stale.length === 0) {
    return {
      id: "compatibility-state",
      label: "Compatibility state",
      status: "ok",
      detail:
        `${recordCount} Wispr Flow run record(s) across ${roots.length} tree(s), none ` +
        `incomplete, no stale checkpoints`,
    };
  }
  return {
    id: "compatibility-state",
    label: "Compatibility state",
    status: "failed",
    detail: [
      incomplete.length > 0 ? `incomplete runs: ${incomplete.join("; ")}` : "",
      stale.length > 0 ? `stale checkpoints: ${stale.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" | "),
    remedy:
      "Finish each incomplete run with `bun run benchmark -- --resume <runId>`, or move it out " +
      "of the results tree to discard it. Starting a batch across the same clips would record " +
      "two measurements of each and leave the tie to a timestamp. Delete any `.tmp` file " +
      "listed: it is a write that never got renamed and nothing reads it.",
  };
}

// -- Machine checks: need the bridge, the product and Core Audio --

/**
 * The checks that need Wispr Flow running and the native bridge built.
 *
 * Opens the bridge once and closes it in a `finally`, so a failed check does not leave
 * a subprocess behind. A bridge that will not start at all is itself reported as a
 * failed check rather than thrown, because "run `bun run build:native`" is the useful
 * answer and an unhandled spawn error is not.
 */
export async function machineChecks(options: PreflightOptions): Promise<Check[]> {
  let adapter: WisprFlowAdapter;
  try {
    adapter = new WisprFlowAdapter();
  } catch (error) {
    return [
      {
        id: "native-bridge",
        label: "Native bridge",
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        remedy: "Build it: `bun run build:native`.",
      },
    ];
  }

  try {
    const [product, preflight] = await Promise.all([
      adapter.metadata(),
      adapter.preflight(options.deviceName),
    ]);
    const checks: Check[] = [];

    checks.push(
      preflight.productRunning
        ? {
            id: "flow-running",
            label: "Wispr Flow running",
            status: "ok",
            detail: product.version ?? "version unknown",
          }
        : {
            id: "flow-running",
            label: "Wispr Flow running",
            status: "failed",
            detail: "not running",
            remedy:
              "Launch Wispr Flow and leave it running for the whole batch. Its microphone must " +
              `be set to ${options.deviceName} manually — Flow exposes no supported automation ` +
              "API, which is why every configuration term is recorded in the run note instead.",
          },
    );

    checks.push(
      supportsVirtualMicrophone(product.version)
        ? {
            id: "flow-version",
            label: "Virtual-microphone release",
            status: "ok",
            detail: `${product.version} >= ${MINIMUM_VIRTUAL_MIC_FLOW_VERSION}`,
          }
        : {
            id: "flow-version",
            label: "Virtual-microphone release",
            status: "failed",
            detail: `${product.version ?? "unknown"} < ${MINIMUM_VIRTUAL_MIC_FLOW_VERSION}`,
            remedy:
              `Update Wispr Flow. ${MINIMUM_VIRTUAL_MIC_FLOW_VERSION} is the first release that ` +
              "documents virtual-microphone selection; older builds silently ignore the device " +
              "choice and would record the room instead of the corpus.",
          },
    );

    checks.push(
      preflight.outputDeviceFound
        ? {
            id: "audio-device",
            label: `Audio device: ${options.deviceName}`,
            status: "ok",
            detail: "found",
          }
        : {
            id: "audio-device",
            label: `Audio device: ${options.deviceName}`,
            status: "failed",
            detail: `not found. Available: ${preflight.outputDevices.join(", ") || "none"}`,
            remedy:
              "Install BlackHole 2ch with its official installer or Homebrew package and restart " +
              "Core Audio. It stays an external dependency on purpose: BlackHole is GPL-3.0 and " +
              "this harness has no redistribution licence.",
          },
    );

    checks.push(
      preflight.accessibilityTrusted
        ? {
            id: "accessibility",
            label: "Accessibility permission",
            status: "ok",
            detail: "granted to flow-bridge",
          }
        : {
            id: "accessibility",
            label: "Accessibility permission",
            status: "failed",
            detail: "missing",
            remedy:
              "Add native/.build/release/flow-bridge under System Settings -> Privacy & Security " +
              "-> Accessibility, then retry. Without it the bridge cannot post the hotkey, so " +
              "every clip would time out.",
          },
    );

    return checks;
  } catch (error) {
    return [
      {
        id: "native-bridge",
        label: "Native bridge",
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        remedy:
          "Rebuild the bridge (`bun run build:native`) and check that Wispr Flow is running.",
      },
    ];
  } finally {
    await adapter.close().catch(() => undefined);
  }
}

/** Every check, machine half included. */
export async function allChecks(options: PreflightOptions): Promise<Check[]> {
  return [...repositoryChecks(options), ...(await machineChecks(options))];
}

/** The failed checks, or an empty list. */
export function failures(checks: readonly Check[]): Check[] {
  return checks.filter((check) => check.status === "failed");
}

/** One aligned line per check, remedy indented under a failure. */
export function formatChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((check) => check.label.length), 0);
  const lines: string[] = [];
  for (const check of checks) {
    const mark = check.status === "ok" ? "OK  " : check.status === "failed" ? "FAIL" : "SKIP";
    lines.push(`  [${mark}] ${check.label.padEnd(width)}  ${check.detail}`);
    if (check.remedy) lines.push(`         -> ${check.remedy}`);
  }
  return lines.join("\n");
}

// -- helpers --

function countFiles(dir: string): number {
  try {
    return readdirSync(dir).length;
  } catch {
    return 0;
  }
}

/**
 * Where a Codictate Speech Model artifact can be, in the order it is looked for.
 *
 * The real one is the app-data models directory - Codictate's
 * `src/bun/platform/runtime.ts::MODELS_DIR`, which is
 * `<app data>/codictate/models`, and where `benchmarks/stt/runner.ts` loads
 * `speech.artifactName` from. The vendored and in-checkout paths are also checked
 * because a developer machine can have either.
 *
 * Searched rather than constructed, because the artifact naming lives in Codictate
 * (`ggml-large-v3-q5_0.bin` for a whisper model, `hviske-v5-tiny-q5_0.gguf` for
 * hviske) and a second copy of that convention here would rot silently. A match is any
 * file whose name contains the model id, and the searched paths are printed on a
 * failure so a wrong guess is visible rather than mysterious.
 */
function modelDirectories(codictatePath: string): string[] {
  const appDataRoot =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : (process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"));
  return [
    join(appDataRoot, "codictate", "models"),
    join(codictatePath, "vendors", "whisper"),
    join(codictatePath, "benchmarks", "models"),
    join(codictatePath, "models"),
  ];
}

/** The model artifact for a model id, or `null`. */
function findModelFile(codictatePath: string, model: string): string | null {
  for (const dir of modelDirectories(codictatePath)) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.includes(model)) return join(dir, name);
    }
  }
  return null;
}

/**
 * Free bytes on the filesystem holding `path`, or `null` when it cannot be read.
 *
 * Walks up to the nearest directory that exists first. The path being checked is
 * usually the batch's own output directory, which does not exist yet on the first
 * invocation - and `df` on a missing path fails, which would have reported a real
 * disk-space problem as "could not be read on this platform".
 */
function freeBytes(path: string): number | null {
  let target = resolve(path);
  for (let depth = 0; depth < 8 && !existsSync(target); depth++) {
    const parent = resolve(target, "..");
    if (parent === target) break;
    target = parent;
  }
  if (!existsSync(target)) return null;
  try {
    const result = Bun.spawnSync(["df", "-k", target]);
    if (result.exitCode !== 0) return null;
    const line = new TextDecoder().decode(result.stdout).trim().split("\n").at(-1);
    const available = line?.trim().split(/\s+/)[3];
    const kilobytes = Number(available);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : null;
  } catch {
    return null;
  }
}

function gib(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

/** `.tmp` files left by a write that never got renamed. */
function staleTemporaryFiles(resultsRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name.endsWith(".tmp")) found.push(path);
    }
  };
  walk(resultsRoot, 0);
  return found;
}

if (import.meta.main) {
  const deviceName = process.argv[2] ?? "BlackHole 2ch";
  const options: PreflightOptions = {
    codictatePath: resolve(import.meta.dir, "../../codictate"),
    deviceName,
    datasets: [...DATASET_IDS],
    resultsRoot: resolve(import.meta.dir, "../results"),
  };
  const checks = await allChecks(options);
  console.log("Preflight");
  console.log(formatChecks(checks));
  const failed = failures(checks);
  if (failed.length > 0) {
    console.log(`\n${failed.length} check(s) failed: ${failed.map((c) => c.id).join(", ")}`);
    process.exitCode = 1;
  } else {
    console.log("\nAll checks passed.");
  }
}
