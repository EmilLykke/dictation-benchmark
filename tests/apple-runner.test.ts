import { expect, test } from "bun:test";
import { applePlaylist, parseAppleArgs } from "../src/apple-runner";
import type { ManifestEntry } from "../src/types";

test("Apple runs require a matching explicit regional locale", () => {
  expect(() => parseAppleArgs(["--dataset", "da_dk"])).toThrow("da region locale");
  expect(parseAppleArgs(["--dataset", "da_dk", "--locale", "da-DK"]).locale).toBe("da-DK");
  expect(() => parseAppleArgs(["--dataset", "es_419", "--locale", "es-419"])).toThrow();
  expect(parseAppleArgs(["--dataset", "es_419", "--locale", "es-MX"]).locale).toBe("es-MX");
});

test("Apple shortcut does not share Flow's default; invalid bounds fail before hardware", () => {
  expect(parseAppleArgs([]).hotkey.spec).toBe("option+x");
  for (const args of [["--samples", "0"], ["--from", "-1"], ["--timeout-ms", "1000"], ["--samples"], ["--processing-mode", "offline"]]) {
    expect(() => parseAppleArgs(args)).toThrow();
  }
});

test("Apple selection preserves the reserved warmup pool and shared scored offset", () => {
  const manifest = Array.from({ length: 10 }, (_, i) => ({ clipId: `clip-${i}` }) as ManifestEntry);
  const selected = applePlaylist(manifest, 2, 3);
  expect(selected.map(x => x.entry.clipId)).toEqual(["clip-0", "clip-1", "clip-2", "clip-5", "clip-6", "clip-7"]);
  expect(selected.map(x => x.warmup)).toEqual([true, true, true, false, false, false]);
  expect(() => applePlaylist(manifest, 7, 1)).toThrow();
  expect(() => applePlaylist(manifest, 6, 2)).toThrow();
});
