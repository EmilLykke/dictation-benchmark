import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { clipIdFromAbsoluteAudioPath } from "./contract";
import type { DatasetId, ManifestEntry } from "./types";
import { wavDurationSec } from "./wav";

const FLEURS_LANGUAGES: Record<string, string> = {
  es_419: "es",
  da_dk: "da",
  hu_hu: "hu",
};

export function buildManifest(datasetsDir: string, dataset: DatasetId): ManifestEntry[] {
  // Resolved once, here, because it is the root every `clipId` is taken relative to
  // and `clipIdFromAbsoluteAudioPath` refuses a path that is not under it. The entry
  // paths are already absolute (`resolve` below), so a caller-supplied relative root
  // would make every clip look like it lived outside the corpus.
  const root = resolve(datasetsDir);
  return dataset.startsWith("test-")
    ? buildLibriSpeechManifest(root, dataset)
    : buildFleursManifest(root, dataset);
}

export function seededShuffle<T>(input: readonly T[], seed: number): T[] {
  const result = [...input];
  let state = seed;
  for (let i = result.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function buildLibriSpeechManifest(datasetsDir: string, split: string): ManifestEntry[] {
  const sourceDir = join(datasetsDir, "librispeech", split);
  const wavDir = join(datasetsDir, "librispeech", "wav", split);
  if (!existsSync(sourceDir)) throw new Error(`Missing LibriSpeech split: ${sourceDir}`);

  const entries: ManifestEntry[] = [];
  for (const transcriptFile of findFiles(sourceDir, ".trans.txt")) {
    for (const line of readFileSync(transcriptFile, "utf8").split("\n")) {
      const separator = line.indexOf(" ");
      if (separator < 1) continue;
      const id = line.slice(0, separator);
      const audioPath = resolve(wavDir, `${id}.wav`);
      if (!existsSync(audioPath)) continue;
      entries.push({
        id,
        clipId: clipIdFromAbsoluteAudioPath(audioPath, datasetsDir),
        audioPath,
        transcript: line.slice(separator + 1).trim(),
        language: "en",
        audioDurationSec: wavDurationSec(audioPath),
      });
    }
  }
  return seededShuffle(entries, 42);
}

/**
 * One FLEURS locale, in deterministic seed-42 order.
 *
 * **Column 1 (`file_name`) is identity; column 0 is not.** FLEURS records several
 * speakers per sentence, so column 0 — the sentence id — repeats: Danish has 930 rows
 * behind 350 distinct column-0 values, Spanish 908 behind 348, Hungarian 905 behind 348
 * (measured 2026-09-04, pinned in `tests/fleurs-identity.manual.ts`). Every row has a
 * matching wav on disk, so the row count is the clip count.
 *
 * That collision was defect 1. `id` used to be the only identity an entry had, and the
 * runner deduplicated its already-captured set on it, so a planned 400-clip Danish
 * range resolved to **264 distinct audio files** while still recording a depth of 400 -
 * measured over the committed manifest and reproduced in
 * `tests/fleurs-identity.manual.ts`.
 *
 * The archived run `results/20260902_181511_wispr-flow-all-400` is **not** evidence of
 * that skip and must not be quoted as if it were: it holds 400 samples with 400 distinct
 * `audioPath` values, so the product really did hear all 397 of its scored clips. That
 * run predates intra-run deduplication, and it is evidence only that the ids collide -
 * 264 distinct across its 400 Danish samples.
 *
 * `clipId` - the corpus-relative POSIX audio path, from column 1 - is now the identity,
 * `sentenceId` keeps column 0 as metadata, and `id` stays only because the v1
 * `manifestFingerprint` is taken over it and every committed `selection` offset indexes
 * into that ordering.
 */
function buildFleursManifest(datasetsDir: string, locale: string): ManifestEntry[] {
  const root = join(datasetsDir, "fleurs", locale);
  const tsvPath = join(root, "test.tsv");
  if (!existsSync(tsvPath)) throw new Error(`Missing FLEURS manifest: ${tsvPath}`);

  const lines = readFileSync(tsvPath, "utf8").split("\n").filter((line) => line.trim());
  // Header detection agrees with Codictate's, deliberately: the two harnesses must
  // select the same rows in the same order or every recorded offset means something
  // different in each. A FLEURS `test.tsv` as downloaded has no header at all; the
  // check exists for a hand-exported one, and it accepts either column name because
  // Codictate accepts either.
  const header = lines[0] ?? "";
  const data = header.includes("file_name") || header.includes("transcription")
    ? lines.slice(1)
    : lines;
  const entries: ManifestEntry[] = [];
  for (const line of data) {
    const columns = line.split("\t");
    if (columns.length < 4) continue;
    const audioPath = resolve(root, "audio", "test", columns[1]);
    if (!existsSync(audioPath)) continue;
    entries.push({
      // Column 0 is the *sentence* id and it repeats, so it is the label and never
      // identity. See `ManifestEntry.id` and `buildFleursManifest`'s own note.
      id: `${locale}_${columns[0]}`,
      clipId: clipIdFromAbsoluteAudioPath(audioPath, datasetsDir),
      sentenceId: columns[0],
      audioPath,
      rawTranscript: columns[2],
      transcript: columns[3],
      language: FLEURS_LANGUAGES[locale] ?? locale.split("_")[0],
      audioDurationSec: wavDurationSec(audioPath),
    });
  }
  return seededShuffle(entries, 42);
}

function findFiles(dir: string, suffix: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...findFiles(path, suffix));
    else if (entry.name.endsWith(suffix)) files.push(path);
  }
  return files;
}

