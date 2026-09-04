import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DATASET_IDS, type ManifestEntry } from "../src/types";
import { transcribeRequest, withTimeoutMs, type RunConfig } from "../src/runner";

describe("benchmark CLI defaults", () => {
  test("plans every dataset when --datasets is omitted", async () => {
    const root = resolve(import.meta.dir, "..");
    const process = Bun.spawn(
      [
        "bun",
        resolve(root, "src/runner.ts"),
        "--name",
        "all-datasets-default",
        "--samples",
        "4",
        "--dry-run",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Datasets:  ${DATASET_IDS.join(", ")}`);
    expect(stdout).toContain("Clips:     20 (3 warmups per dataset)");
  });
});

const CONFIG: RunConfig = {
  codictatePath: "/tmp/codictate",
  datasets: [...DATASET_IDS],
  samples: 20,
  deviceName: "BlackHole 2ch",
  hotkey: { keyCode: 49, modifiers: ["option"] },
  leadMs: 500,
  tailMs: 500,
  timeoutMs: 45_000,
  stableMs: 750,
  configurationNote: "",
};

function entry(audioDurationSec: number): ManifestEntry {
  return {
    id: `clip-${audioDurationSec}`,
    audioPath: `/tmp/clip-${audioDurationSec}.wav`,
    transcript: "reference",
    language: "en",
    audioDurationSec,
  };
}

describe("per-clip timeout", () => {
  // main.swift stamps `stoppedAt` after playback, so the value the bridge gets
  // is a post-playback deadline. Adding audio duration would count the clip
  // twice, which is what 77d49fc did.
  test("timeout sent to the bridge does not vary with audioDurationSec", () => {
    const short = transcribeRequest(CONFIG, entry(2));
    const long = transcribeRequest(CONFIG, entry(30.8));

    expect(short.timeoutMs).toBe(CONFIG.timeoutMs);
    expect(long.timeoutMs).toBe(short.timeoutMs);
  });

  test("every clip length in a plan gets the identical timeout", () => {
    const timeouts = new Set(
      [0.5, 5.3, 12, 30.8, 120].map((seconds) => transcribeRequest(CONFIG, entry(seconds)).timeoutMs),
    );

    expect([...timeouts]).toEqual([45_000]);
  });
});

describe("resuming older run records", () => {
  test("keeps a pre-77d49fc flat timeoutMs", () => {
    const config = withTimeoutMs({ ...CONFIG, timeoutMs: 45_000 });

    expect(config.timeoutMs).toBe(45_000);
  });

  test("reads a 77d49fc-era timeoutBudgetMs as the flat post-playback timeout", () => {
    const { timeoutMs: _dropped, ...legacy } = CONFIG;
    const config = withTimeoutMs({ ...legacy, timeoutBudgetMs: 30_000 } as RunConfig);

    expect(config.timeoutMs).toBe(30_000);
    expect(transcribeRequest(config, entry(30.8)).timeoutMs).toBe(30_000);
  });

  test("an explicit timeoutMs wins over a recorded budget", () => {
    const config = withTimeoutMs({ ...CONFIG, timeoutMs: 45_000, timeoutBudgetMs: 30_000 });

    expect(config.timeoutMs).toBe(45_000);
  });
});
