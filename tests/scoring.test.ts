import { describe, expect, test } from "bun:test";
import {
  computeCer as computeCodictateCer,
  computeWer as computeCodictateWer,
} from "../../codictate/benchmarks/stt/wer";
import {
  normalizeForCer as normalizeCodictateForCer,
  normalizeForWer as normalizeCodictateForWer,
} from "../../codictate/benchmarks/stt/normalize";
import {
  computeCer,
  computeWer,
  normalizeForCer,
  normalizeForWer,
} from "../src/scoring";
import { supportsVirtualMicrophone } from "../src/adapters/wispr-flow";

describe("normalizeForWer", () => {
  test("matches Codictate punctuation and artifact normalization", () => {
    expect(normalizeForWer(" Hello, WORLD! [music] 42. ")).toBe("hello world 42");
  });

  test("stays identical to Codictate normalization and scoring", () => {
    const samples = [
      " Hello, WORLD! [music] 42. ",
      "[BLANK_AUDIO] (music) [silence] [Applause] [Laughter]",
      "ÆØÅ café déjà-vu — español １２３",
      "tabs\tnewlines\nmultiple   spaces",
      "can't sight-seers… ‘quoted’ 😊",
      "",
    ];

    for (const reference of samples) {
      expect(normalizeForWer(reference)).toBe(normalizeCodictateForWer(reference));
      expect(normalizeForCer(reference)).toBe(normalizeCodictateForCer(reference));
      for (const hypothesis of samples) {
        expect(computeWer(reference, hypothesis)).toEqual(
          computeCodictateWer(reference, hypothesis),
        );
        expect(computeCer(reference, hypothesis)).toEqual(
          computeCodictateCer(reference, hypothesis),
        );
      }
    }
  });
});

describe("Wispr Flow version gate", () => {
  test("accepts virtual-microphone release and newer versions", () => {
    expect(supportsVirtualMicrophone("1.6.579")).toBe(false);
    expect(supportsVirtualMicrophone("1.6.580")).toBe(true);
    expect(supportsVirtualMicrophone("1.7.0")).toBe(true);
    expect(supportsVirtualMicrophone(null)).toBe(false);
  });
});

describe("computeWer", () => {
  test("counts substitutions, insertions, and deletions", () => {
    const result = computeWer("one two three four", "one too extra four");
    expect(result).toEqual({
      wer: 0.5,
      substitutions: 2,
      insertions: 0,
      deletions: 0,
      refWords: 4,
    });
  });

  test("handles empty hypotheses", () => {
    expect(computeWer("one two", "")).toEqual({
      wer: 1,
      substitutions: 0,
      insertions: 0,
      deletions: 2,
      refWords: 2,
    });
  });
});

describe("computeCer", () => {
  test("preserves punctuation and case like Codictate FLEURS scoring", () => {
    expect(computeCer("Hej!", "hej?")).toEqual({
      cer: 0.5,
      substitutions: 2,
      insertions: 0,
      deletions: 0,
      refChars: 4,
    });
  });
});
