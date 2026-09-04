import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildManifest, seededShuffle } from "../src/manifest";

const datasetsDir = resolve(import.meta.dir, "../../codictate/benchmarks/datasets");

describe("seededShuffle", () => {
  test("is stable and non-mutating", () => {
    const input = [1, 2, 3, 4, 5];
    expect(seededShuffle(input, 42)).toEqual([2, 5, 4, 1, 3]);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
});

describe.skipIf(!existsSync(datasetsDir))("Codictate dataset compatibility", () => {
  test("selects same deterministic LibriSpeech prefix", () => {
    expect(buildManifest(datasetsDir, "test-clean").slice(0, 5).map((entry) => entry.id)).toEqual([
      "4970-29095-0017",
      "6829-68771-0013",
      "2830-3980-0042",
      "908-31957-0014",
      "6829-68771-0030",
    ]);
  });

  test("selects same deterministic Danish FLEURS prefix", () => {
    expect(buildManifest(datasetsDir, "da_dk").slice(0, 5).map((entry) => entry.id)).toEqual([
      "da_dk_1702",
      "da_dk_1908",
      "da_dk_1694",
      "da_dk_1909",
      "da_dk_1987",
    ]);
  });
});
