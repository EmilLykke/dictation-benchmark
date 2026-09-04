# Dictation Product Benchmark

Black-box macOS benchmark for Wispr Flow. It plays Codictate's existing benchmark WAV files through a virtual microphone at 1.0× speed, captures text pasted by Flow, and calculates Word Error Rate with the same normalization and deterministic sample order used by Codictate.

Repository stays separate from Codictate because this measures an external product—including audio capture, cloud processing, formatting, personalization, and paste behavior—not a Codictate ASR Harness.

Current scope: Wispr Flow only. `ProductAdapter` keeps runner independent from Flow-specific control without adding unused providers.

## Requirements

- macOS 13+
- Bun and Swift toolchain
- sibling Codictate checkout at `../codictate`
- Wispr Flow account and desktop app 1.6.580 or newer (first release documenting virtual-microphone selection)
- user-installed BlackHole 2ch

BlackHole remains external. Do not bundle it: BlackHole is GPL-3.0 and this private harness has not obtained a redistribution license.

## One-time setup

1. Install BlackHole 2ch using its official installer or Homebrew package, then restart Core Audio/macOS when requested.
2. In Wispr Flow, open **Settings → General → Microphone → Change → Show other devices** and select **BlackHole 2ch**. Do not leave microphone on Auto-detect.
3. Set Flow's dedicated **Hands-free** shortcut to **Option+Space**. Runner sends macOS virtual key code `49` with Option. Whitespace-only shortcut leakage is ignored.
4. Turn off Flow Context Awareness. Clear personal/team dictionary state where practical. Enable Flow's automatic/multilingual language detection when running all datasets. For stricter fixed-language comparisons, pass `--datasets` explicitly and run one language configuration at a time.
5. Keep Flow running. Disable Flow sound effects so notification audio cannot contaminate virtual input.
6. Install dependencies and build native bridge:

   ```bash
   bun install
   bun run build:native
   ```

7. Grant Accessibility permission to terminal application running benchmark. If preflight still reports missing permission, add `native/.build/release/flow-bridge` under **System Settings → Privacy & Security → Accessibility**.

Check all machine prerequisites without starting dictation:

```bash
bun run preflight
```

Flow microphone choice, hotkey, language, Context Awareness, account state, and privacy settings are manual because Flow exposes no supported desktop automation API. Record them through `--configuration-note`.

Omitting `--datasets` runs every dataset in this order: `test-clean`, `test-other`, `es_419`, `da_dk`, `hu_hu`. Passing `--datasets` still limits a run; `test-clean,test-other` may run together under fixed English configuration.

## Sample selection: what a run measures

A dataset's clips are one deterministic ordered list. `buildManifest` ends in
`seededShuffle(entries, 42)`, so the order is a property of the corpus and not of
the run. That is what makes accumulation possible: "which clips has this repository
already measured for this product" is fully described by a single integer offset
into that list, so there is no per-clip ledger anywhere.

**The first three entries of each dataset are a reserved warmup pool.** They are
replayed unscored at the start of every session and are never consumed. The
consumable range therefore starts at manifest index 3, which is why `hu_hu` has 905
clips but 902 consumable ones. Warmups used to be taken off the front of the range
a session was about to measure; under accumulation that would have burned three
fresh clips per dataset per session, forever.

**The cursor is derived from `results/`, not stored separately.** Every run records,
per dataset, the half-open range of consumable entries it measured and a fingerprint
of the ordered clip IDs those offsets index into:

```json
"hu_hu": {
  "samples": [ ... ],
  "aggregate": { ... },
  "selection": {
    "selectionVersion": 1,
    "warmupCount": 3,
    "manifestFingerprint": "sha256:9ce1d747...c787ee",
    "manifestEntryCount": 905,
    "consumableCount": 902,
    "startIndex": 397,
    "endIndex": 797,
    "plannedEndIndex": 797,
    "requestedEndIndex": 797,
    "truncated": false
  }
}
```

The cursor for a dataset is the largest `endIndex` across every run in `results/`
whose `manifestFingerprint` matches the current manifest, counted per **product**
rather than per product version — Flow auto-updates, so a per-version cursor would
reset every few days and never accumulate. `endIndex` is rewritten after every clip,
so a run that dies halfway advances the cursor by the clips it finished rather than
the clips it intended; `plannedEndIndex` is what `--resume` continues towards. The
scan is cached in `results/.selection-cache.json`, which is derived, gitignored, and
safe to delete.

`manifestFingerprint` is `sha256` over the dataset's ordered clip IDs, one per line,
and nothing else. Re-encoding a WAV or re-normalising a transcript does not
invalidate a cursor. Adding, removing or reordering a clip does.

### The fingerprint guard

If the current manifest's fingerprint differs from one a prior run recorded, the
ordering changed and every stored offset now names different clips. **The runner
refuses to run.** It does not fall back to starting from zero, because that would
re-measure some clips, never measure others, and leave no trace a reader could
detect. The error names the dataset, both fingerprints, the run that recorded the
old one, and the three ways out: restore the dataset files, archive the affected
runs out of `results/` to start a fresh accumulation, or exclude those datasets with
`--datasets` and keep accumulating the rest.

## Depth flags

| Flag | Meaning |
| --- | --- |
| `--samples N` | **Delta.** Run N consumable clips this repository has not measured before for this product, from wherever each dataset's cursor sits. Defaults to 20. |
| `--to N` | **Target depth.** Run whatever is needed for N consumable clips to have been measured in total, and do nothing where that is already true. |

They are mutually exclusive. Warmups are outside both counts: `--samples 4` plays
seven clips per dataset and scores four.

`--samples` is destructive by default — running the same command twice consumes
twice — so a **plan preview is always printed before any clip runs**, one line per
dataset:

```
Plan:
  test-clean: cursor 397 -> 797 (clips 398-797 of 2617 consumable, 1820 remaining after)
  test-other: cursor 397 -> 797 (clips 398-797 of 2936 consumable, 2139 remaining after)
  es_419: cursor 397 -> 797 (clips 398-797 of 905 consumable, 108 remaining after)
  da_dk: cursor 397 -> 797 (clips 398-797 of 927 consumable, 130 remaining after)
  hu_hu: cursor 397 -> 797 (clips 398-797 of 902 consumable, 105 remaining after)
```

`--to` is the flag for an interrupted overnight command, because re-running it is
safe: a dataset already at or past the target prints its line and measures nothing.

```
  hu_hu: cursor 397 -> 397 (nothing to run: already at or past depth 397 of 902 consumable)
```

When fewer clips remain than were asked for, that dataset is truncated to what is
left, logged loudly, recorded at the depth it actually reached, **and the run
continues to the next dataset.** An exhausted `es_419` must not abort an overnight
command that could still measure the other four. Nothing ever wraps around and
re-uses a clip.

```
  es_419: cursor 397 -> 905 (clips 398-905 of 905 consumable, 0 remaining after) [EXHAUSTED: depth 1000 requested, 95 beyond the corpus; running the 508 that remain]
```

## Validate dataset plan

`--dry-run` prints the plan and exits. It touches neither Flow nor any measured
result; the only thing it may write is the derived cursor cache.

```bash
bun run benchmark -- \
  --name english-smoke \
  --datasets test-clean \
  --samples 20 \
  --dry-run
```

Defaults reference `../codictate/benchmarks/datasets`. Override checkout location with `--codictate /absolute/path/to/codictate`.

## Run Wispr Flow benchmark

Run the next 20 unmeasured clips from every dataset (100 scored, 15 warmup replays):

```bash
bun run benchmark -- \
  --name wispr-flow-all-20 \
  --samples 20 \
  --configuration-note "Flow 1.x; multilingual/Auto-detect; Context Awareness off; clean dictionary"
```

Run one English dataset only:

```bash
bun run benchmark -- \
  --name wispr-flow-english-smoke \
  --datasets test-clean \
  --samples 20 \
  --configuration-note "Flow 1.x; English only; Context Awareness off; clean dictionary"
```

Runner opens **Dictation Benchmark Receiver**. Do not change focus while run is active. Each dataset's first three clips are replayed as warmups, matching Codictate's current benchmark behavior; they never contribute to aggregate WER and are never consumed.

After separate English and Danish smoke runs pass, larger example:

```bash
bun run benchmark -- \
  --name wispr-flow-english-200 \
  --datasets test-clean,test-other \
  --samples 200 \
  --configuration-note "Flow version recorded in results; English only; Context Awareness off"
```

## Running a corpus in sessions

A full `hu_hu` pass is 902 consumable clips and hours of real-time playback, so it
gets done a session at a time. Worked example, starting from the committed
400-clip run, which measured consumable entries `[0, 397)` of all five datasets.

Session 1 — check where the cursor is without spending anything:

```bash
bun run benchmark -- --name where-am-i --datasets hu_hu --samples 200 --dry-run
#   hu_hu: cursor 397 -> 597 (clips 398-597 of 902 consumable, 305 remaining after)
```

Session 2 — measure those 200. Warmups 1-3 replay first, then clips 398-597:

```bash
bun run benchmark -- \
  --name hu-session-2 \
  --datasets hu_hu \
  --samples 200 \
  --configuration-note "Flow version recorded in results; multilingual/Auto-detect"
#   hu_hu: cursor 397 -> 597 (clips 398-597 of 902 consumable, 305 remaining after)
```

Session 3 — the cursor has moved on its own. The same command measures 598-797,
never 398-597 again:

```bash
bun run benchmark -- --name hu-session-3 --datasets hu_hu --samples 200 ...
#   hu_hu: cursor 597 -> 797 (clips 598-797 of 902 consumable, 105 remaining after)
```

Session 4 — finish the corpus. `--to 902` asks for a depth rather than a delta, so
if it dies at clip 850 the identical command picks up the remaining 52 and if it
succeeds the identical command is a no-op:

```bash
bun run benchmark -- --name hu-session-4 --datasets hu_hu --to 902 ...
#   hu_hu: cursor 797 -> 902 (clips 798-902 of 902 consumable, 0 remaining after)
# re-run after success:
#   hu_hu: cursor 902 -> 902 (nothing to run: all 902 consumable clips already measured)
```

Each session is its own run directory with its own recorded Flow version, so an
aggregate pooled across sessions can state the version mix it spans rather than
claiming a single version. Pool accuracy as `sum(errors) / sum(referenceWords)`
using the `referenceWords` and `referenceChars` counts each leaf publishes; never
average the rates.

### Backfilling a run made before ranges were recorded

A run without a `selection` record contributes nothing to a cursor. The committed
`results/20260902_181511_wispr-flow-all-400` predates the scheme and was backfilled
with this script, which verifies the mapping against the stored clip IDs — sample
`i` is manifest entry `i`, the three warmups are the manifest head, scored sample
`j` is consumable entry `j` — and refuses to write anything for a run that does not
satisfy it:

```bash
bun run backfill:selection results/<timestamp>_<name>          # report only
bun run backfill:selection --write results/<timestamp>_<name>  # record the ranges
```

It confirmed 397 scored clips per dataset mapping to consumable `[0, 397)`, and
wrote only the five `selection` objects: no measured number was touched.

## Per-clip timeout

A clip's timeout is a flat deadline that starts when dictation stops:

```
give up if no stable text within timeoutMs of the hotkey that ends the clip
```

The bridge stamps `stoppedAt` only after playback and the tail have finished
(`native/Sources/FlowBridge/main.swift`), so the timeout never overlaps
playback: a 5s clip and a 36s clip each get the whole budget to produce text.
Clip duration must not be added to it — that would count the audio twice.

It defaults to `45000` ms and is set with `--timeout-ms <n>`:

```bash
bun run benchmark -- \
  --name wispr-flow-all-20 \
  --samples 20 \
  --timeout-ms 45000
```

The value used by a run is recorded in `results.json` under `config.timeoutMs`,
so results are self-describing. All published runs here used 45000 ms.

One intermediate revision recorded `config.timeoutBudgetMs` instead, from a
short-lived attempt to make the timeout audio-relative. Such a record still
parses; resuming it reads the budget as the flat post-playback timeout, since
that is what the budget already was, and prints a line saying so. A record
carrying both fields keeps its explicit `config.timeoutMs`.

Runner writes two atomic progress files after every finished clip:

- `results.json` preserves every hypothesis, error operation, latency, and status. Resume uses this file.
- `checkpoint.json` mirrors Codictate's completed-dataset and in-progress aggregate layout. It is removed only after successful completion.

Recorded paths are portable, because runs are committed here: `audioPath` is
relative to the Codictate datasets root (`fleurs/da_dk/audio/test/<hash>.wav`,
`librispeech/wav/test-clean/<id>.wav`) and `config.codictatePath` is written as
`<codictate>`. Resuming points that placeholder back at `../codictate`, or at
whatever `--codictate` supplies.

Resume interrupted run without repeating finished clips:

```bash
bun run benchmark -- --resume results/<timestamp>_<name>
```

`--resume` skips clips already captured in that run directory and continues towards
the range the run recorded, rather than replanning from the cursor. Replanning would
be wrong: the run's own finished clips have already advanced the cursor, so a fresh
plan would start past them and leave a hole in the middle of the run. A resumed run
also re-verifies its recorded fingerprint, and refuses if a dataset holds scored
samples but no recorded range — that run predates this scheme and must be backfilled
first.

Successful completion also writes `stt.json`. Its top-level structure, dataset grouping, and metric fields match Codictate's current benchmark output. Product identity remains explicit under `external-product → wispr-flow`; it is never mislabeled as CrispASR or whisper-cli.

For an overnight 200-sample run across all five datasets:

```bash
bun run benchmark -- \
  --name wispr-flow-all-200 \
  --samples 200 \
  --configuration-note "Flow version recorded in results; multilingual/Auto-detect; Context Awareness off; clean dictionary"
```

## Response time, and why no speed figure comes out of the committed run

The per-clip `stopToFirstTextMs` in `results.json` is the gap between the stop
hotkey and text appearing in the receiver window. It is the only timing an
external product allows, and for one run it was published as a speed figure.
That was wrong, and this section is the record of it.

**What went wrong.** `main.swift` stamped `stoppedAt` on the line after the stop
hotkey, and then, on the next line, restored the user's default output device
with `setDefaultOutputDevice`. That call is synchronous and blocks while Core
Audio reconfigures. `switchedOutput` is true on every clip, because the device
is restored after each clip and the next clip switches again, so every
`stopToFirstTextMs` this harness ever recorded contains one output-device
restore.

**How much.** Roughly 300 ms per clip, and it is visible in the data rather than
merely plausible. In `results/20260902_181511_wispr-flow-all-400`, the fifteen
fastest scored clips are 271 to 321 ms at audio durations of 1.7 to 4.0 seconds.
A cost that does not move while the audio it supposedly processes more than
doubles is a fixed cost, not marginal work, and it is the whole of the
regression intercepts: 317 ms on test-clean, 316 on test-other, 285 on es_419.

**What it cost the conclusion.** That run pooled to 123 ms per second of audio.
Charge the fixed term back to the harness and it pools to 91 to 96, which is
faster than `large-v3-q5_0` at 99 rather than slower. The published ordering was
an artifact of the measuring apparatus, so **no speed figure is published from
this run**, and `stt.json` carries none: `responseMsPerAudioSec`,
`totalStopToFirstTextMs`, `respondedAudioSec`, `meanStopToFirstTextMs` and
`meanStopToStableTextMs` were all removed from the transform. The raw per-clip
numbers stay in `results.json`, where they are labelled as what they are.

**What was fixed, for runs after 2026-09-04.**

- The restore moved out of the measured window rather than the stamp moving
  later. `stoppedAt` has to keep meaning "the instant the stop hotkey was
  delivered"; stamping it after the restore would have produced the same clean
  number by quietly redefining the measurement. The bridge now restores the
  device on the way out of `transcribe`, after the response window has closed.
- Each clip records its own overhead. `outputDeviceRestoreMs` is the measured
  cost of that restore, now beside the latency instead of inside it, and
  `stopToFirstTextHarnessMs` is the harness work that remains inside the
  window: time spent hopping to the main thread to read the receiver window,
  summed over the polls up to the one that first saw text. A future run states
  its overhead as a measurement instead of leaving a reader to infer it from
  the floor of a scatter plot.
- The poll interval dropped from a hardcoded 50 ms to a configurable 10 ms.
  The interval is the granularity of `stopToFirstTextMs`, so it is a mean
  upward bias of half an interval: 25 ms became 5 ms. It is verifiably jitter
  rather than quantization in the committed run, whose latencies are near
  uniform modulo 50 ms. The value used is recorded in `results.json` under
  `config.pollIntervalMs`, and in `stt.json` under `config.pollIntervalMs`
  beside `config.stableMs`, so a run is self-describing about both of the
  harness's own timing terms. Set it with `--poll-interval-ms <n>`. Runs made
  before the field existed have no value; resuming one fills in the 50 ms the
  bridge used at the time, so the two halves of a single run keep one
  granularity.

A future run made with this bridge can publish a speed figure. Reinstating the
aggregates in `src/codictate-compat.ts` is the deliberate second step, taken
once such a run exists and can print its own overhead next to its own number.

## Metrics and comparison rules

- Audio always plays at 1.0×. Core Audio/BlackHole stays real-time.
- Source identity and order match Codictate's seed-42 manifests.
- Failed or timed-out clips score as empty hypotheses, matching Codictate failure scoring.
- Aggregate WER excludes the three replayed warmups per dataset. Warmups are the reserved head of the ordered manifest and are never part of a consumable range, so they are neither scored nor counted as measured.
- Every run records the consumable range and manifest fingerprint it measured, per dataset, under `results.<dataset>.selection`. Two runs of the same dataset with non-overlapping ranges measured disjoint clips and can be pooled; the same range twice cannot happen unless a `results/` directory was edited by hand.
- Exact output remains preserved alongside normalized WER operations. FLEURS also receives Codictate-compatible CER against raw transcript.
- `stt.json` exposes the same `wer`, `cer`, `meanRTF`, `utteranceCount`, `totalAudioSec`, and `totalWallSec` fields as Codictate. `peakRSS_MB` is `null` because process memory is not meaningful for a managed external product.
- WER and CER are directly comparable when conditions match. Speed is not: `stt.json` publishes no speed or latency aggregate at all. `meanRTF` remains on the leaf because it is what the harness clocked, but it is floored at 1.0 by playback the harness chose to do and is not comparable with Codictate's inference RTF or with anything else.
- Stop-to-first-text and stop-to-stable-text remain in rich `results.json` for product latency analysis, with `stopToFirstTextHarnessMs` and `outputDeviceRestoreMs` beside them. Read [Response time](#response-time-and-why-no-speed-figure-comes-out-of-the-committed-run) before deriving a speed figure from a run recorded before 2026-09-04: those runs restored the default output device inside the measured window.
- If a future run does publish one, state alongside it that Flow streams audio while the user is still speaking, so part of its transcription overlaps with speech and is invisible here, and that the figure is the wait after stopping rather than Flow's total compute.
- Compare same clip IDs, language configuration, date window, machine, and repeat count. Flow service/model changes require new versioned runs.
- A figure pooled across sessions must disclose the Flow versions it spans. The cursor is per product, not per product version, precisely because Flow auto-updates and a per-version cursor would never accumulate; the compensation is that `product.version` is recorded per run, so the version mix behind a pooled number is always recoverable and must be stated.

## Checks

```bash
bun run check
```

Full feasibility research and primary sources: [docs/WISPR_FLOW_BENCHMARK_FEASIBILITY.md](docs/WISPR_FLOW_BENCHMARK_FEASIBILITY.md).
