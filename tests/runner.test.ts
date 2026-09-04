import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DATASET_IDS, type ManifestEntry } from "../src/types";
import {
  transcribeRequest,
  withPollIntervalMs,
  withTimeoutMs,
  type RunConfig,
} from "../src/runner";

async function dryRun(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const root = resolve(import.meta.dir, "..");
  const child = Bun.spawn(["bun", resolve(root, "src/runner.ts"), ...args, "--dry-run"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("benchmark CLI defaults", () => {
  test("plans every dataset when --datasets is omitted", async () => {
    const { exitCode, stdout, stderr } = await dryRun("--name", "all-datasets-default", "--samples", "4");

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Datasets:  ${DATASET_IDS.join(", ")}`);
    // Warmups are reserved, so they sit outside the 4 clips --samples asked for:
    // five datasets contribute 3 replays plus 4 scored clips each.
    expect(stdout).toContain("Clips:     35 (15 warmup replays + 20 scored)");
    expect(stdout).toContain("Depth:     --samples 4 (delta: 4 more per dataset, from the cursor)");
  });

  test("prints one plan preview line per dataset before anything runs", async () => {
    const { exitCode, stdout } = await dryRun("--name", "plan-preview", "--samples", "4");

    expect(exitCode).toBe(0);
    for (const dataset of DATASET_IDS) {
      // `--samples` is a delta, so the operator has to be able to read off which
      // consumable clips a command is about to spend before it spends them.
      const line = stdout.match(
        new RegExp(
          `^  ${dataset}: cursor (\\d+) -> (\\d+) \\(clips (\\d+)-(\\d+) of (\\d+) consumable, (\\d+) remaining after\\)$`,
          "m",
        ),
      );
      expect(line, dataset).not.toBeNull();
      const [cursor, end, firstClip, lastClip, consumable, remaining] = line!.slice(1).map(Number);
      expect(end - cursor, dataset).toBe(4);
      expect(firstClip, dataset).toBe(cursor + 1);
      expect(lastClip, dataset).toBe(end);
      expect(remaining, dataset).toBe(consumable - end);
    }
  });

  test("--dry-run exits without writing a run directory", async () => {
    const { exitCode, stdout } = await dryRun("--name", "dry-run-writes-nothing", "--samples", "4");
    const runId = stdout.match(/^Run:\s+(\S+)$/m)?.[1];

    expect(exitCode).toBe(0);
    expect(runId).toBeDefined();
    expect(existsSync(resolve(import.meta.dir, "..", "results", runId!))).toBe(false);
  });

  test("rejects --samples and --to together", async () => {
    const { exitCode, stderr } = await dryRun("--name", "both-depths", "--samples", "4", "--to", "10");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("not both");
  });

  test("a --to depth already reached is a no-op rather than a repeat", async () => {
    const { exitCode, stdout } = await dryRun("--name", "already-there", "--to", "1");

    expect(exitCode).toBe(0);
    // The committed 400-clip run recorded depth 397 for every dataset, so a target of
    // 1 is behind the cursor everywhere.
    for (const dataset of DATASET_IDS) {
      expect(stdout).toContain(`${dataset}: cursor 397 -> 397 (nothing to run:`);
    }
  });

  test("--from rewinds past the cursor and the preview says so, per dataset", async () => {
    const { exitCode, stdout, stderr } = await dryRun(
      "--name",
      "from-rewind",
      "--from",
      "0",
      "--samples",
      "400",
    );

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "From:      --from 0 (explicit start into the consumable range; the cursor is ignored for this run only)",
    );
    expect(stdout).toContain(
      "REWIND: 5 datasets will re-measure clips already measured.",
    );
    for (const dataset of DATASET_IDS) {
      // The committed 400-clip run left every dataset at 397, so --from 0 rewinds all
      // five. Nothing may read as the ordinary forward `cursor A -> B` line.
      expect(stdout).toContain(
        `${dataset}: REWIND cursor 397 -> --from 0 (re-measuring clips 1-400 of`,
      );
      expect(stdout).toContain("397 of them already measured; cursor ends at 400, never lower than 397)");
      expect(stdout).not.toContain(`${dataset}: cursor 397 -> 400`);
    }
  });

  test("--from 0 --samples 400 and --from 0 --to 400 name the same clips", async () => {
    const delta = await dryRun("--name", "from-delta", "--from", "0", "--samples", "400");
    const target = await dryRun("--name", "from-target", "--from", "0", "--to", "400");

    expect(delta.exitCode).toBe(0);
    expect(target.exitCode).toBe(0);
    for (const dataset of DATASET_IDS) {
      const line = (out: string) =>
        out.match(new RegExp(`^  ${dataset}: .*$`, "m"))?.[0].replace(/^ +/, "");
      expect(line(target.stdout), dataset).toBe(line(delta.stdout));
    }
    // Two full manifest builds in one test; the default 5s deadline is not enough.
  }, 30_000);

  test("rejects --from without a depth flag", async () => {
    const { exitCode, stderr } = await dryRun("--name", "from-alone", "--from", "0");

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--from needs a depth flag");
  });

  test("rejects --from together with --resume", async () => {
    const { exitCode, stderr } = await dryRun(
      "--from",
      "0",
      "--samples",
      "4",
      "--resume",
      "results/does-not-matter",
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Use --from or --resume, not both");
  });

  test("rejects a --from past a dataset's consumable count, naming the count", async () => {
    const { exitCode, stderr } = await dryRun(
      "--name",
      "from-too-deep",
      "--from",
      "999999",
      "--samples",
      "4",
    );

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(
      /--from 999999 is out of range for \S+: it has \d+ consumable clips, so the valid --from indices are 0-\d+\./,
    );
  });

  test("rejects a negative --from", async () => {
    const { exitCode, stderr } = await dryRun(
      "--name",
      "from-negative",
      "--from",
      "-1",
      "--samples",
      "4",
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--from must be a non-negative integer index");
  });

  test("--description is accepted as an alias of --configuration-note", async () => {
    // Codictate's harness spells the free-text note --description, so the same command
    // shape has to work here. Both spellings write config.configurationNote.
    const note = await dryRun("--name", "note-alias", "--samples", "4", "--description", "verify timing fix");
    const legacy = await dryRun(
      "--name",
      "note-alias",
      "--samples",
      "4",
      "--configuration-note",
      "verify timing fix",
    );

    expect(note.stderr).toBe("");
    expect(note.exitCode).toBe(0);
    expect(legacy.exitCode).toBe(0);
  }, 30_000);

  test("plans every dataset even where the requested depth exhausts the corpus", async () => {
    const { exitCode, stdout } = await dryRun("--name", "exhaustion", "--to", "100000");

    // buildPlan used to throw when one dataset was short, aborting the whole run.
    expect(exitCode).toBe(0);
    for (const dataset of DATASET_IDS) {
      expect(stdout).toContain(`${dataset}: cursor 397 ->`);
      expect(stdout).toContain("EXHAUSTED");
    }
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
  pollIntervalMs: 10,
  configurationNote: "",
};

function entry(audioDurationSec: number): ManifestEntry {
  return {
    id: `clip-${audioDurationSec}`,
    clipId: `librispeech/wav/test-clean/clip-${audioDurationSec}.wav`,
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

  test("fills in the 50ms poll interval those runs actually used", () => {
    const { pollIntervalMs: _dropped, ...legacy } = CONFIG;
    const config = withPollIntervalMs(legacy as RunConfig);

    // Not the current 10ms default: resuming at a finer granularity would give the two
    // halves of one run different stopToFirstTextMs resolution.
    expect(config.pollIntervalMs).toBe(50);
    expect(transcribeRequest(config, entry(2)).pollIntervalMs).toBe(50);
  });

  test("keeps an interval a record already names", () => {
    expect(withPollIntervalMs({ ...CONFIG, pollIntervalMs: 25 }).pollIntervalMs).toBe(25);
  });
});

describe("poll interval", () => {
  // The interval is the granularity of stopToFirstTextMs: text landing between two
  // reads is not seen until the later one, so the measurement carries a mean upward
  // bias of half an interval. It was 50ms, worth +25ms; 10ms makes it +5ms.
  test("is sent to the bridge and is small enough not to dominate a measurement", () => {
    const request = transcribeRequest(CONFIG, entry(2));

    expect(request.pollIntervalMs).toBe(10);
    expect(request.pollIntervalMs / 2).toBeLessThanOrEqual(5);
  });

  test("defaults rather than sending undefined for a record without one", () => {
    const { pollIntervalMs: _dropped, ...legacy } = CONFIG;

    expect(transcribeRequest(legacy as RunConfig, entry(2)).pollIntervalMs).toBe(10);
  });
});
