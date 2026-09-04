import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest } from "../src/manifest";
import { portableAudioPath } from "../src/portable-paths";
import { clipIdFromAbsoluteAudioPath, uniqueInOrder } from "../src/contract";

/**
 * Defect 1, on a synthetic mirror of the real corpus.
 *
 * `benchmarks/datasets/` is git-ignored, so the CI-safe test builds its own FLEURS
 * locale whose column 0 repeats the way the real one does, and the measured numbers
 * from the real corpus are pinned as `FLEURS_IDENTITY_WITNESS` in
 * `tests/fleurs-identity.manual.ts` (SPEC addendum §M).
 *
 * The shape being tested: FLEURS TSV column 0 is the *sentence* id and repeats;
 * column 1 is the unique audio file name. Before the fix `buildManifest` built ids as
 * `${locale}_${columns[0]}`, and `src/runner.ts` deduplicated on that, so a planned
 * 400-clip range invoked the adapter on roughly 265 distinct audio files while
 * recording `endIndex: 400`.
 */
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A 44-byte silent 8 kHz mono 16-bit WAV: enough for `wavDurationSec`. */
function silentWav(samples: number): Buffer {
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(8_000, 24); // sample rate
  buffer.writeUInt32LE(16_000, 28); // byte rate
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

/**
 * A FLEURS locale whose column 0 repeats `speakersPerSentence` times, like the real
 * one. `sentences * speakersPerSentence` wav files, `sentences` distinct column-0
 * values.
 */
function fleursLocale(sentences: number, speakersPerSentence: number): string {
  const root = mkdtempSync(join(tmpdir(), "fleurs-identity-"));
  temporaryRoots.push(root);
  const audioDir = join(root, "fleurs", "da_dk", "audio", "test");
  mkdirSync(audioDir, { recursive: true });

  const rows: string[] = [];
  for (let sentence = 0; sentence < sentences; sentence++) {
    for (let speaker = 0; speaker < speakersPerSentence; speaker++) {
      const fileName = `${sentence}${speaker}${"0".repeat(16)}.wav`;
      writeFileSync(join(audioDir, fileName), silentWav(8_000 + sentence));
      rows.push(
        // id, file_name, raw_transcription, transcription, ...
        [`${1000 + sentence}`, fileName, `Rå sætning ${sentence}`, `sætning ${sentence}`, "x"].join("\t"),
      );
    }
  }
  writeFileSync(join(root, "fleurs", "da_dk", "test.tsv"), `${rows.join("\n")}\n`);
  return root;
}

describe("FLEURS clip identity", () => {
  test("every selected audio file gets a distinct clipId, even though column 0 repeats", () => {
    // 350 sentences x 2 speakers: 700 wavs behind 350 distinct column-0 values,
    // the same collision ratio the real Danish locale has.
    const entries = buildManifest(fleursLocale(350, 2), "da_dk");

    expect(entries).toHaveLength(700);
    expect(uniqueInOrder(entries.map((entry) => entry.clipId))).toHaveLength(700);
    // The pre-fix identity, kept as a label. It still collides, and that is the point:
    // nothing may key on it.
    expect(uniqueInOrder(entries.map((entry) => entry.id))).toHaveLength(350);
  });

  test("a 400-clip range names 400 distinct audio files", () => {
    // Acceptance gate 1. Before the fix the same range deduplicated to ~265.
    const entries = buildManifest(fleursLocale(350, 2), "da_dk");
    const range = entries.slice(3, 403);

    expect(range).toHaveLength(400);
    expect(new Set(range.map((entry) => entry.clipId)).size).toBe(400);
    expect(new Set(range.map((entry) => entry.id)).size).toBeLessThan(400);
  });

  test("column 0 survives as sentenceId metadata and is allowed to repeat", () => {
    const entries = buildManifest(fleursLocale(3, 2), "da_dk");

    expect(entries.every((entry) => entry.sentenceId !== undefined)).toBe(true);
    expect(new Set(entries.map((entry) => entry.sentenceId)).size).toBe(3);
    // The label id is the locale-prefixed sentence id, unchanged from v1.
    expect(entries.every((entry) => entry.id === `da_dk_${entry.sentenceId}`)).toBe(true);
  });

  test("clipId is column 1, not column 0", () => {
    const entries = buildManifest(fleursLocale(2, 1), "da_dk");
    for (const entry of entries) {
      expect(entry.clipId).toBe(`fleurs/da_dk/audio/test/${entry.audioPath.split("/").at(-1)}`);
      expect(entry.clipId).not.toContain(entry.sentenceId!);
    }
  });

  test("clipId string-matches portableAudioPath, which writes the committed records", () => {
    // SPEC §1: the two derivations must agree character for character, or the archive
    // and the pool disagree about which clip a number belongs to.
    const root = fleursLocale(4, 2);
    const datasetsRoot = root;
    for (const entry of buildManifest(root, "da_dk")) {
      expect(entry.clipId).toBe(portableAudioPath(entry.audioPath, datasetsRoot));
      expect(entry.clipId).toBe(clipIdFromAbsoluteAudioPath(entry.audioPath, datasetsRoot));
    }
  });
});

describe("LibriSpeech clip identity", () => {
  function librispeech(count: number): string {
    const root = mkdtempSync(join(tmpdir(), "librispeech-identity-"));
    temporaryRoots.push(root);
    const sourceDir = join(root, "librispeech", "test-clean", "1272", "128104");
    const wavDir = join(root, "librispeech", "wav", "test-clean");
    mkdirSync(sourceDir, { recursive: true });
    mkdirSync(wavDir, { recursive: true });
    const lines: string[] = [];
    for (let index = 0; index < count; index++) {
      const id = `1272-128104-${String(index).padStart(4, "0")}`;
      writeFileSync(join(wavDir, `${id}.wav`), silentWav(8_000));
      lines.push(`${id} THE REFERENCE ${index}`);
    }
    writeFileSync(join(sourceDir, "1272-128104.trans.txt"), `${lines.join("\n")}\n`);
    return root;
  }

  test("clipId is the relative wav path and the utterance id stays the label", () => {
    const entries = buildManifest(librispeech(5), "test-clean");

    expect(entries).toHaveLength(5);
    expect(new Set(entries.map((entry) => entry.clipId)).size).toBe(5);
    for (const entry of entries) {
      expect(entry.clipId).toBe(`librispeech/wav/test-clean/${entry.id}.wav`);
      expect(entry.sentenceId).toBeUndefined();
    }
  });
});
