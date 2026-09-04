/**
 * Speech Model weights: what the batch needs, what is already on disk, and fetching the
 * rest **before** the first clip.
 *
 * The 18-model production matrix needs roughly 20 GB of weights and three of the
 * eighteen are typically present, so the download is not a detail of the run - it is a
 * step that can fail, takes tens of minutes, and must not be discovered at 3am fifteen
 * stages in. `bench:stt` downloads lazily at the start of each stage, which is right for
 * a single-model run and wrong for a matrix: a night dies on stage sixteen because a
 * mirror was down.
 *
 * So this module does it up front, once, with a per-model verdict, and the batch refuses
 * to start measuring until every weight it will need is on disk.
 *
 * ## Why this reads the Codictate checkout at runtime
 *
 * The catalogue (`src/shared/speech-models.ts`) and the downloader
 * (`src/bun/utils/whisper/model-manager.ts`) live in Codictate, which is a **runtime**
 * value here (`--codictate`). They are loaded through a computed specifier for the same
 * reason `src/contract/` is a mirror: a static import would bind this repository to one
 * checkout, and this one has to fetch weights for whichever checkout is about to be
 * measured. A copy of the catalogue would be worse than either - it would go stale
 * silently and then report the wrong size and the wrong artifact name.
 *
 * Everything here therefore fails **soft on the load** and **hard on the download**: if
 * the modules cannot be loaded the batch says so with the path it tried, because that is
 * an operator's mistake with an obvious fix; if a weight cannot be fetched the batch
 * stops, because measuring fifteen models and skipping three is a matrix with a hole in
 * it.
 *
 * Nothing here ever deletes a weight. Codictate has `--offload-models`; this
 * orchestrator never passes it and never calls `deleteModel`. A resumed stage would
 * otherwise re-download a gigabyte and charge it to the first clip's wall time.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The fields this module reads off a Codictate `SpeechModel`. */
export interface SpeechModelInfo {
  id: string;
  /** The file or directory name under the models root. */
  artifactName: string;
  /** `whisper_cpp`, `hviske`, `whisperkit` (Parakeet). */
  engine: string;
  downloadSizeMB: number;
  label?: string;
}

/** What the batch knows about one model it needs. */
export interface ModelStatus {
  id: string;
  artifactName: string;
  engine: string;
  downloadSizeMB: number;
  /** Already on disk, per Codictate's own availability check. */
  present: boolean;
  /**
   * Whether the batch can fetch it if it is missing.
   *
   * `false` for Parakeet: its Core ML / ONNX bundle is installed by the Codictate app,
   * not by a file fetch, and `bench:stt`'s own download step skips it for the same
   * reason. A missing non-downloadable model is a hard preflight failure with the
   * remedy, rather than a download that would appear to work and then not.
   */
  downloadable: boolean;
}

export type ModelOutcome = "present" | "fetched" | "failed" | "not-downloadable";

export interface ModelResult extends ModelStatus {
  outcome: ModelOutcome;
  /** The engine's own words, on a failure. */
  error?: string;
  /** Wall time of the fetch, when one happened. */
  elapsedMs?: number;
}

interface ModelManagerLike {
  isModelAvailable(modelId: string): boolean;
  downloadModel(
    modelId: string,
    onProgress: (fraction: number, done: boolean, error?: string) => void,
  ): void;
}

/** Engines whose weights are a single file the downloader can fetch. */
const DOWNLOADABLE_ENGINES = new Set(["whisper_cpp", "hviske"]);

function specifier(codictatePath: string, relative: string): string {
  return pathToFileURL(join(codictatePath, relative)).href;
}

/**
 * The Codictate model catalogue, or a throw naming the path it looked at.
 *
 * `import()` rather than a copy, so the artifact names and sizes are the ones the
 * checkout being measured actually uses.
 */
export async function loadSpeechModels(codictatePath: string): Promise<SpeechModelInfo[]> {
  const relative = "src/shared/speech-models.ts";
  const path = join(codictatePath, relative);
  if (!existsSync(path)) {
    throw new Error(
      `Cannot read the Speech Model catalogue: ${path} does not exist. Point --codictate at a ` +
        `Codictate checkout. The batch reads the catalogue rather than carrying a copy, because ` +
        `a copy would report stale sizes and artifact names without saying so.`,
    );
  }
  const loaded = (await import(specifier(codictatePath, relative))) as {
    SPEECH_MODELS?: SpeechModelInfo[];
  };
  if (!Array.isArray(loaded.SPEECH_MODELS)) {
    throw new Error(`${path} does not export SPEECH_MODELS.`);
  }
  return loaded.SPEECH_MODELS;
}

/** Codictate's own model manager, or a throw naming the path it looked at. */
export async function loadModelManager(codictatePath: string): Promise<ModelManagerLike> {
  const relative = "src/bun/utils/whisper/model-manager.ts";
  const path = join(codictatePath, relative);
  if (!existsSync(path)) {
    throw new Error(
      `Cannot read the model downloader: ${path} does not exist. Point --codictate at a ` +
        `Codictate checkout.`,
    );
  }
  const loaded = (await import(specifier(codictatePath, relative))) as {
    modelManager?: ModelManagerLike;
  };
  if (!loaded.modelManager) {
    throw new Error(`${path} does not export modelManager.`);
  }
  return loaded.modelManager;
}

/**
 * What the batch needs and what it already has, in the order the models were asked for.
 *
 * Availability comes from Codictate's `isModelAvailable` rather than from a file
 * existence check here: it is the same predicate the run itself will use, so a
 * disagreement between preflight and the run is impossible by construction. A model id
 * the catalogue does not know is an error, not a skip - it would otherwise be reported
 * as missing, fail to download, and read as a network problem.
 */
export async function modelInventory(
  codictatePath: string,
  modelIds: readonly string[],
): Promise<ModelStatus[]> {
  const [catalogue, manager] = await Promise.all([
    loadSpeechModels(codictatePath),
    loadModelManager(codictatePath),
  ]);
  const byId = new Map(catalogue.map((model) => [model.id, model]));

  return modelIds.map((id) => {
    const model = byId.get(id);
    if (!model) {
      throw new Error(
        `Unknown Speech Model "${id}". The Codictate catalogue at ${codictatePath} lists ` +
          `${catalogue.length} models; check the spelling in --models. Reporting it as missing ` +
          `would send the batch off to download something that does not exist.`,
      );
    }
    return {
      id: model.id,
      artifactName: model.artifactName,
      engine: model.engine,
      downloadSizeMB: model.downloadSizeMB,
      present: manager.isModelAvailable(model.id),
      downloadable: DOWNLOADABLE_ENGINES.has(model.engine),
    };
  });
}

/** Megabytes the batch will have to fetch. Zero when everything is already on disk. */
export function pendingDownloadMB(statuses: readonly ModelStatus[]): number {
  return statuses
    .filter((status) => !status.present && status.downloadable)
    .reduce((total, status) => total + status.downloadSizeMB, 0);
}

/** Models that are missing and cannot be fetched by the batch. A hard stop. */
export function unfetchable(statuses: readonly ModelStatus[]): ModelStatus[] {
  return statuses.filter((status) => !status.present && !status.downloadable);
}

/**
 * Fetch every missing weight, one at a time, before any measurement.
 *
 * Sequential on purpose. Parallel downloads of twenty-odd gigabytes compete for the
 * same link and make the progress meaningless, and the failure that matters - a mirror
 * that is down - is just as visible one at a time. **Stops on the first failure**, with
 * the model named: a matrix missing three of eighteen models is not a smaller matrix,
 * it is a comparison with a hole in it, and the operator needs to know before the night
 * is spent rather than after.
 */
export async function downloadMissingModels(
  codictatePath: string,
  modelIds: readonly string[],
  log: (line: string) => void = console.log,
): Promise<ModelResult[]> {
  const statuses = await modelInventory(codictatePath, modelIds);
  const manager = await loadModelManager(codictatePath);
  const results: ModelResult[] = [];

  const blocked = unfetchable(statuses);
  if (blocked.length > 0) {
    throw new Error(
      `${blocked.length} Speech Model(s) are missing and cannot be fetched by this batch: ` +
        `${blocked.map((status) => `${status.id} (engine ${status.engine})`).join(", ")}. ` +
        `Install them through the Codictate app - a Parakeet bundle is not a file this step can ` +
        `download - or drop them from the batch with --models.`,
    );
  }

  const toFetch = statuses.filter((status) => !status.present);
  log(
    toFetch.length === 0
      ? `All ${statuses.length} Speech Model(s) are already on disk. Nothing to download.`
      : `Fetching ${toFetch.length} of ${statuses.length} Speech Model(s), ` +
          `${(pendingDownloadMB(statuses) / 1024).toFixed(1)} GB. Nothing is measured until ` +
          `every one of them is on disk.`,
  );

  for (const status of statuses) {
    if (status.present) {
      log(`  [${status.id}] present (${status.artifactName})`);
      results.push({ ...status, outcome: "present" });
      continue;
    }
    log(`  [${status.id}] downloading ${status.downloadSizeMB} MB ...`);
    const startedAt = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        manager.downloadModel(status.id, (_fraction, done, error) => {
          if (!done) return;
          if (error) reject(new Error(error));
          else resolve();
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ...status, outcome: "failed", error: message });
      log(`  [${status.id}] FAILED: ${message}`);
      throw new Error(
        `Speech Model "${status.id}" could not be downloaded: ${message}\n\n` +
          `Stopping before any clip is measured. A batch that carried on would measure the ` +
          `models it happened to have and publish a matrix with a hole in it. Re-run the same ` +
          `command once the download can succeed - models already fetched are kept and are not ` +
          `re-downloaded.`,
      );
    }
    const elapsedMs = Date.now() - startedAt;
    log(`  [${status.id}] fetched in ${(elapsedMs / 1000).toFixed(0)}s`);
    results.push({ ...status, outcome: "fetched", elapsedMs });
  }

  return results;
}

/** One aligned line per model, for the preflight block and the readiness report. */
export function formatModelStatuses(statuses: readonly ModelStatus[]): string {
  const width = Math.max(...statuses.map((status) => status.id.length), 0);
  return statuses
    .map((status) => {
      const mark = status.present
        ? "OK  "
        : status.downloadable
          ? "GET "
          : "FAIL";
      const detail = status.present
        ? status.artifactName
        : status.downloadable
          ? `will download ${status.downloadSizeMB} MB (${status.artifactName})`
          : `missing, and engine ${status.engine} is not downloadable by this batch`;
      return `  [${mark}] ${status.id.padEnd(width)}  ${detail}`;
    })
    .join("\n");
}
