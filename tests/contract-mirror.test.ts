import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as mirror from "../src/contract";

/**
 * The guard that makes the mirror route honest: `src/contract/` must stay a **byte**
 * copy of `codictate/benchmarks/contract/`.
 *
 * `src/contract/index.ts` explains why this repository mirrors the canonical contract
 * rather than importing it. The cost of a mirror is drift, and drift was previously
 * caught by nothing that CI runs: `tests/contract-parity.manual.ts` is a `.manual.ts`
 * file and is excluded from `bun test`; there was no checksum anywhere; the parity
 * comparison was behavioural rather than textual, so a changed *comment* or a changed
 * error message would pass; the export check was one-directional, so a canonical
 * **removal** was invisible; and it was wrapped in a `describe.skipIf` that reported
 * green vacuously on a machine without the sibling checkout.
 *
 * This file fixes all five. It is a `.test.ts` file, so it runs in CI. It compares
 * bytes, so a comment drifting is a failure. It compares the export sets in **both**
 * directions. And when the sibling checkout is genuinely absent it says so loudly on
 * stdout and asserts the things it still can - the fingerprint literals below - rather
 * than passing in silence.
 */
const canonicalDir = resolve(import.meta.dir, "../../codictate/benchmarks/contract");
const mirrorDir = resolve(import.meta.dir, "../src/contract");
const havecanonical = existsSync(join(canonicalDir, "index.ts"));

if (!havecanonical) {
  console.warn(
    `\n[contract-mirror] The canonical contract is not at ${canonicalDir}, so the byte ` +
      `comparison of src/contract/ could not run. The fingerprint literals below are still ` +
      `asserted. Re-run this suite with the sibling Codictate checkout present before ` +
      `trusting src/contract/.\n`,
  );
}

/**
 * The mirror header every copied module carries, stripped before comparison.
 *
 * The header is the **only** permitted difference, and it is permitted because a reader
 * who opens one of these files has to be told immediately that editing it forks the
 * archive. Located by its terminator rather than by a line count, so reflowing it does
 * not silently start comparing the wrong offset.
 */
const HEADER_END = "*/\n\n";

function stripMirrorHeader(text: string): string {
  const first = text.indexOf(HEADER_END);
  if (first === -1) {
    throw new Error("A mirrored module has no mirror header. Add one; see any sibling file.");
  }
  return text.slice(first + HEADER_END.length);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The modules mirrored verbatim. `index.ts` is compared separately: its head differs. */
const MIRRORED_MODULES = [
  "aggregation.ts",
  "clip-identity.ts",
  "harness.ts",
  "schema.ts",
  "selection.ts",
  "timing.ts",
  "v1-leaf.ts",
];

describe("the fingerprint algorithm, pinned independently of the fixture", () => {
  /**
   * The same seven values `tests/fixtures/fingerprint-v2.json` carries, written out
   * here as literals.
   *
   * Deliberate duplication. The fixture is a file that could in principle be replaced
   * along with the implementation; these literals are in the test source, so replacing
   * both is a visible edit to a reviewer. They also mean this file still asserts
   * something real on a checkout with no sibling contract, which is the case the old
   * `skipIf` passed vacuously.
   */
  const PINNED: ReadonlyArray<readonly [string, readonly string[], string]> = [
    ["empty", [], "223d0698c3a11acc"],
    ["single", ["fleurs/da_dk/audio/test/a.wav"], "598545a60238693a"],
    ["order-matters-a", ["b.wav", "a.wav"], "6a4aee3d67640368"],
    ["order-matters-b", ["a.wav", "b.wav"], "fe6e1a10333a02a4"],
    ["dedup", ["a.wav", "a.wav", "b.wav"], "fe6e1a10333a02a4"],
    ["unicode", ["fleurs/da_dk/audio/test/æøå.wav"], "6d715bef704237f2"],
    [
      "real-fleurs-da-first-5",
      [
        "fleurs/da_dk/audio/test/12149430079508542992.wav",
        "fleurs/da_dk/audio/test/1892314626509120692.wav",
        "fleurs/da_dk/audio/test/11657230937236500261.wav",
        "fleurs/da_dk/audio/test/10016401698104160032.wav",
        "fleurs/da_dk/audio/test/15945042231538223000.wav",
      ],
      "d28f996584b02f28",
    ],
  ];

  for (const [name, clipIds, expected] of PINNED) {
    test(`${name} is ${expected}`, () => {
      expect(mirror.fingerprintV2(clipIds)).toBe(expected);
    });
  }

  test("the golden fixture file agrees with the literals above", () => {
    // If these two ever disagree, one of them was edited without the other, and that is
    // the edit a reviewer needs to see rather than a green suite.
    const fixture = JSON.parse(
      readFileSync(resolve(import.meta.dir, "fixtures/fingerprint-v2.json"), "utf8"),
    ) as { cases: Array<{ name: string; fingerprint: string }> };
    for (const [name, , expected] of PINNED) {
      const found = fixture.cases.find((entry) => entry.name === name);
      expect([name, found?.fingerprint]).toEqual([name, expected]);
    }
  });
});

describe.skipIf(!havecanonical)("src/contract/ is a byte copy of the canonical contract", () => {
  test("the golden fixture file is byte-identical", () => {
    const here = readFileSync(resolve(import.meta.dir, "fixtures/fingerprint-v2.json"));
    const there = readFileSync(join(canonicalDir, "fixtures/fingerprint-v2.json"));
    expect(sha256(here.toString("utf8"))).toBe(sha256(there.toString("utf8")));
  });

  test("every mirrored module matches the canonical one byte for byte", () => {
    const drifted: string[] = [];
    for (const file of MIRRORED_MODULES) {
      const canonicalText = readFileSync(join(canonicalDir, file), "utf8");
      const mirrorText = stripMirrorHeader(readFileSync(join(mirrorDir, file), "utf8"));
      if (mirrorText !== canonicalText) {
        drifted.push(
          `${file}: mirror sha ${sha256(mirrorText).slice(0, 16)} != canonical ` +
            `${sha256(canonicalText).slice(0, 16)}`,
        );
      }
    }
    // Named rather than counted, because the useful output of this failing is which
    // file to re-copy.
    expect(drifted).toEqual([]);
  });

  test("no canonical module is missing from the mirror, and none is invented", () => {
    const isModule = (name: string) =>
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".manual.ts") &&
      name !== "index.ts";
    const canonicalModules = readdirSync(canonicalDir).filter(isModule).sort();
    const mirrorModules = readdirSync(mirrorDir).filter(isModule).sort();

    // A canonical *addition* this repository has not mirrored is a gap; a module here
    // that canonical does not have is a fork. Both directions.
    expect(mirrorModules).toEqual(canonicalModules);
    expect([...MIRRORED_MODULES].sort()).toEqual(canonicalModules);
  });

  test("index.ts re-exports exactly the canonical list, byte for byte", () => {
    const exportsOf = (text: string) => text.slice(text.indexOf("export {"));
    const canonicalIndex = readFileSync(join(canonicalDir, "index.ts"), "utf8");
    const mirrorIndex = readFileSync(join(mirrorDir, "index.ts"), "utf8");

    expect(exportsOf(mirrorIndex)).toBe(exportsOf(canonicalIndex));
  });

  test("the runtime export sets agree in BOTH directions", async () => {
    // One-directional was the gap: a canonical *removal* left an extra export here and
    // nothing noticed, so this repository could keep calling something the contract had
    // dropped. Computed specifier, so `tsc` does not pull the sibling repository into
    // this one's type-check graph.
    const canonical = (await import(
      join(canonicalDir, "index.ts")
    )) as Record<string, unknown>;

    const missing = Object.keys(canonical).filter((name) => !(name in mirror));
    const extra = Object.keys(mirror).filter((name) => !(name in canonical));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });
});
