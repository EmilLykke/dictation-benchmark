/**
 * Defect 1 against the real corpus.
 *
 * A `.manual.ts` file, not a `.test.ts` one, per SPEC addendum §M: it reads
 * `<codictate>/benchmarks/datasets`, which is git-ignored, so on a fresh checkout it
 * would turn a missing optional dependency into a red CI gate. The CI-safe half is
 * `tests/manifest-identity.test.ts`, which asserts the same rules on a synthetic
 * corpus built to collide the way this one does, and the numbers this file measures
 * are pinned below as `FLEURS_IDENTITY_WITNESS` so they can be quoted without a
 * corpus.
 *
 * Run it with:
 *
 * ```bash
 * bun test tests/fleurs-identity.manual.ts
 * ```
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildManifest, seededShuffle } from "../src/manifest";
import { consumableEntries } from "../src/selection";
import { fingerprintV2, uniqueInOrder } from "../src/contract";
import { portableAudioPath } from "../src/portable-paths";

const datasetsDir = resolve(import.meta.dir, "../../codictate/benchmarks/datasets");

/**
 * What the corpus actually looks like, measured 2026-09-04 on the checkout this
 * harness runs against. Identical to the numbers SPEC addendum §C records, and to the
 * ones `codictate/benchmarks/contract/fleurs-identity.manual.ts` measures on the other
 * side of the contract.
 *
 * `distinctCol0` is the collision. It is the *sentence* id: FLEURS records several
 * speakers per sentence, so column 0 repeats roughly 2.6 times over. `distinctCol1` is
 * the audio file name and equals the row count, which is what makes it identity.
 *
 * `distinctIdsIn400Range` is the damage, and it is what a 400-clip range *used to*
 * measure: `src/runner.ts` deduplicated its already-captured set on the column-0 id, so
 * a 400-clip Danish range invoked the adapter on 264 distinct audio files and recorded
 * `endIndex: 400` regardless. `distinctClipIdsIn400Range` is 400 in every locale now.
 */
export const FLEURS_IDENTITY_WITNESS = {
  da_dk: {
    rows: 930,
    distinctCol0: 350,
    distinctCol1: 930,
    distinctIdsIn400Range: 264,
    distinctClipIdsIn400Range: 400,
  },
  es_419: {
    rows: 908,
    distinctCol0: 348,
    distinctCol1: 908,
    distinctIdsIn400Range: 266,
    distinctClipIdsIn400Range: 400,
  },
  hu_hu: {
    rows: 905,
    distinctCol0: 348,
    distinctCol1: 905,
    distinctIdsIn400Range: 264,
    distinctClipIdsIn400Range: 400,
  },
} as const;

/**
 * The five clipIds SPEC addendum §B pins for the `real-fleurs-da-first-5` golden
 * fixture: da_dk `test.tsv` column 1, first five data rows, **natural on-disk order**.
 *
 * Natural order deliberately, not `seededShuffle(entries, 42)`, so this repository can
 * reproduce them with `head -5 test.tsv | cut -f2` instead of re-implementing a
 * Codictate detail. `test.tsv` has no header row: 930 data rows.
 */
const REAL_FLEURS_DA_FIRST_5 = [
  "fleurs/da_dk/audio/test/12149430079508542992.wav",
  "fleurs/da_dk/audio/test/1892314626509120692.wav",
  "fleurs/da_dk/audio/test/11657230937236500261.wav",
  "fleurs/da_dk/audio/test/10016401698104160032.wav",
  "fleurs/da_dk/audio/test/15945042231538223000.wav",
];

describe.skipIf(!existsSync(datasetsDir))("FLEURS identity against the real corpus", () => {
  for (const locale of ["da_dk", "es_419", "hu_hu"] as const) {
    const witness = FLEURS_IDENTITY_WITNESS[locale];

    test(`${locale}: column 0 collides and column 1 does not`, () => {
      const entries = buildManifest(datasetsDir, locale);

      expect(entries).toHaveLength(witness.rows);
      expect(uniqueInOrder(entries.map((entry) => entry.sentenceId!))).toHaveLength(
        witness.distinctCol0,
      );
      expect(uniqueInOrder(entries.map((entry) => entry.clipId))).toHaveLength(
        witness.distinctCol1,
      );
      // Every TSV row has a matching wav on disk, so the row count is the clip count.
      expect(witness.distinctCol1).toBe(witness.rows);
    });

    test(`${locale}: a 400-clip range names 400 distinct audio files`, () => {
      // Acceptance gate 1. The `distinctIdsIn400Range` figure is what the same range
      // deduplicated to before the fix, and it is the size of the hole the harness was
      // recording a full depth over.
      const range = consumableEntries(buildManifest(datasetsDir, locale)).slice(0, 400);

      expect(range).toHaveLength(400);
      expect(new Set(range.map((entry) => entry.clipId)).size).toBe(
        witness.distinctClipIdsIn400Range,
      );
      expect(new Set(range.map((entry) => entry.id)).size).toBe(witness.distinctIdsIn400Range);
    });

    test(`${locale}: clipId string-matches the path written into every committed record`, () => {
      // SPEC §1: `portableAudioPath` already produces this exact string, which is why
      // it was chosen rather than invented. If the two ever disagree, the archive and
      // the pool stop agreeing about which clip a number belongs to.
      for (const entry of buildManifest(datasetsDir, locale)) {
        expect(entry.clipId).toBe(portableAudioPath(entry.audioPath, datasetsDir));
      }
    });
  }

  test("the golden fixture's five Danish clipIds are column 1 of the first five rows", () => {
    const tsv = Bun.file(join(datasetsDir, "fleurs", "da_dk", "test.tsv"));
    const rows = Bun.readableStreamToText(tsv.stream());
    return rows.then((text) => {
      const lines = text.split("\n").filter((line) => line.trim());
      expect(lines).toHaveLength(930);
      expect(lines.slice(0, 5).map((line) => `fleurs/da_dk/audio/test/${line.split("\t")[1]}`)).toEqual(
        REAL_FLEURS_DA_FIRST_5,
      );
      // And the fingerprint over them is the value addendum §B pins.
      expect(fingerprintV2(REAL_FLEURS_DA_FIRST_5)).toBe("d28f996584b02f28");
    });
  });

  test("LibriSpeech ids were already unique, and the clipId agrees with them", () => {
    for (const split of ["test-clean", "test-other"] as const) {
      const entries = buildManifest(datasetsDir, split);
      expect(uniqueInOrder(entries.map((entry) => entry.id))).toHaveLength(entries.length);
      expect(uniqueInOrder(entries.map((entry) => entry.clipId))).toHaveLength(entries.length);
      for (const entry of entries.slice(0, 50)) {
        expect(entry.clipId).toBe(`librispeech/wav/${split}/${entry.id}.wav`);
      }
    }
  });

  test("the deterministic order is still seed 42, so every recorded offset still holds", () => {
    expect(seededShuffle([1, 2, 3, 4, 5], 42)).toEqual([2, 5, 4, 1, 3]);
  });
});
