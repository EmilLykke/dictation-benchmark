import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Glob } from "bun";
import { CODICTATE_PATH_PLACEHOLDER, portableRun } from "../src/portable-paths";

/** Matched against JSON text, where a backslash in a Windows path is doubled. */
const ABSOLUTE_PATH = /\/Users\/|\/home\/|[A-Za-z]:\\\\/;

/** Assembled from segments so this file does not itself carry a home-directory path. */
function absolute(...segments: string[]): string {
  return `/${segments.join("/")}`;
}

const checkout = absolute("Users", "example", "Projects", "codictate-project", "codictate");
const datasets = `${checkout}/benchmarks/datasets`;

function runWith(audioPaths: string[], codictatePath = checkout) {
  return {
    runId: "20260902_174410_wispr-flow-proof",
    config: { codictatePath, datasets: ["test-clean", "da_dk"], samples: 4 },
    results: {
      "test-clean": {
        aggregate: { wer: 0.25 },
        samples: audioPaths.map((audioPath, index) => ({
          id: `sample-${index}`,
          audioPath,
          audioDurationSec: 3.93,
          hypothesis: "the quick brown fox",
        })),
      },
    },
  };
}

describe("portableRun", () => {
  test("records audio relative to the Codictate datasets root", () => {
    const record = portableRun(
      runWith([
        `${datasets}/librispeech/wav/test-clean/4970-29095-0017.wav`,
        `${datasets}/fleurs/da_dk/audio/test/1702.wav`,
      ]),
    );

    expect(record.results["test-clean"].samples.map((sample) => sample.audioPath)).toEqual([
      "librispeech/wav/test-clean/4970-29095-0017.wav",
      "fleurs/da_dk/audio/test/1702.wav",
    ]);
    expect(record.config.codictatePath).toBe(CODICTATE_PATH_PLACEHOLDER);
  });

  test("serialises no absolute path", () => {
    const serialised = JSON.stringify(
      portableRun(
        runWith([
          `${datasets}/librispeech/wav/test-clean/4970-29095-0017.wav`,
          absolute("home", "runner", "codictate", "clips", "1702.wav"),
          "C:\\codictate\\clips\\17.wav",
        ]),
      ),
      null,
      2,
    );

    expect(serialised).not.toMatch(ABSOLUTE_PATH);
  });

  test("leaves everything but the paths alone", () => {
    const run = runWith([`${datasets}/librispeech/wav/test-clean/4970-29095-0017.wav`]);
    const record = portableRun(run);

    expect(record.runId).toBe(run.runId);
    expect(record.config.datasets).toEqual(run.config.datasets);
    expect(record.config.samples).toBe(4);
    expect(record.results["test-clean"].aggregate).toEqual({ wer: 0.25 });
    expect(record.results["test-clean"].samples[0].audioDurationSec).toBe(3.93);
    expect(record.results["test-clean"].samples[0].hypothesis).toBe("the quick brown fox");
  });

  test("is idempotent, so a resumed run re-serialises unchanged", () => {
    const clip = "librispeech/wav/test-clean/4970-29095-0017.wav";
    const once = portableRun(runWith([clip], CODICTATE_PATH_PLACEHOLDER));
    const twice = portableRun(once);

    expect(twice).toEqual(once);
    expect(twice.results["test-clean"].samples[0].audioPath).toBe(clip);
  });
});

describe("committed run records", () => {
  test("contain no absolute path", () => {
    const resultsRoot = resolve(import.meta.dir, "../results");
    const files = [...new Glob("*/*.json").scanSync(resultsRoot)];
    const leaking = files.filter((file) =>
      ABSOLUTE_PATH.test(readFileSync(resolve(resultsRoot, file), "utf8")),
    );

    expect(files.length).toBeGreaterThan(0);
    expect(leaking).toEqual([]);
  });
});
