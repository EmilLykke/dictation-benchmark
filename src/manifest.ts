import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DatasetId, ManifestEntry } from "./types";
import { wavDurationSec } from "./wav";

const FLEURS_LANGUAGES: Record<string, string> = {
  es_419: "es",
  da_dk: "da",
  hu_hu: "hu",
};

export function buildManifest(datasetsDir: string, dataset: DatasetId): ManifestEntry[] {
  return dataset.startsWith("test-")
    ? buildLibriSpeechManifest(datasetsDir, dataset)
    : buildFleursManifest(datasetsDir, dataset);
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
        audioPath,
        transcript: line.slice(separator + 1).trim(),
        language: "en",
        audioDurationSec: wavDurationSec(audioPath),
      });
    }
  }
  return seededShuffle(entries, 42);
}

function buildFleursManifest(datasetsDir: string, locale: string): ManifestEntry[] {
  const root = join(datasetsDir, "fleurs", locale);
  const tsvPath = join(root, "test.tsv");
  if (!existsSync(tsvPath)) throw new Error(`Missing FLEURS manifest: ${tsvPath}`);

  const lines = readFileSync(tsvPath, "utf8").split("\n").filter((line) => line.trim());
  const data = lines[0]?.includes("file_name") ? lines.slice(1) : lines;
  const entries: ManifestEntry[] = [];
  for (const line of data) {
    const columns = line.split("\t");
    if (columns.length < 4) continue;
    const audioPath = resolve(root, "audio", "test", columns[1]);
    if (!existsSync(audioPath)) continue;
    entries.push({
      id: `${locale}_${columns[0]}`,
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

