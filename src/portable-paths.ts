import { basename, isAbsolute, join, relative } from "node:path";

/**
 * Placeholder written in place of an absolute Codictate checkout path. Runs are
 * committed to this repository, so the machine that produced them must not be
 * identifiable from the record; `--resume` swaps the placeholder back for the
 * checkout it is pointed at.
 */
export const CODICTATE_PATH_PLACEHOLDER = "<codictate>";

/** `C:\\clips\\17.wav`, `\\\\share\\clips`: absolute, but not to POSIX `isAbsolute`. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

interface PortableSample {
  audioPath: string;
}

interface PortableDataset {
  samples: PortableSample[];
}

interface PortableRun {
  config: { codictatePath: string };
  results: Partial<Record<string, PortableDataset>>;
}

/** Root the recorded `audioPath` values are relative to. */
export function datasetsRoot(codictatePath: string): string {
  return join(codictatePath, "benchmarks", "datasets");
}

/**
 * Strips machine-specific prefixes from a run record. The runner keeps absolute
 * paths in memory — it has to open the WAV files — so this runs at serialisation
 * time only. It is idempotent: a record read back from disk passes through
 * unchanged.
 */
export function portableRun<Run extends PortableRun>(run: Run): Run {
  const root = datasetsRoot(run.config.codictatePath);
  const results: Record<string, PortableDataset> = {};
  for (const [dataset, result] of Object.entries(run.results)) {
    if (!result) continue;
    results[dataset] = {
      ...result,
      samples: result.samples.map((sample) => ({
        ...sample,
        audioPath: portableAudioPath(sample.audioPath, root),
      })),
    };
  }
  // Only string values change, so the caller's record shape survives the rewrite.
  return {
    ...run,
    config: { ...run.config, codictatePath: portableCodictatePath(run.config.codictatePath) },
    results,
  } as Run;
}

/**
 * `fleurs/da_dk/audio/test/<hash>.wav`, `librispeech/wav/test-clean/<id>.wav` —
 * enough to find the clip in any checkout. Already-relative values are kept.
 */
export function portableAudioPath(audioPath: string, root: string): string {
  // A foreign-platform path cannot be made relative to a POSIX root; keep the
  // file name, which is still the useful part, and drop the machine prefix.
  if (WINDOWS_ABSOLUTE.test(audioPath)) return audioPath.split(/[\\/]/).at(-1) ?? audioPath;
  if (!isAbsolute(audioPath)) return audioPath;
  const relativePath = relative(root, audioPath);
  return relativePath.startsWith("..") ? basename(audioPath) : relativePath;
}

/** Keeps a relative checkout path as given; replaces an absolute one. */
export function portableCodictatePath(codictatePath: string): string {
  return isAbsolute(codictatePath) || WINDOWS_ABSOLUTE.test(codictatePath)
    ? CODICTATE_PATH_PLACEHOLDER
    : codictatePath;
}
