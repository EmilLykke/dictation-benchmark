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
3. Set Flow's dedicated **Hands-free** shortcut to **Option+Z**. Runner sends macOS virtual key code `6` with Option, and that is the default in both entry points. Nothing here can verify the shortcut Flow is listening on — Flow exposes no supported desktop automation API — so a mismatch does not error, it times out on every clip. Pass `--flow-hotkey <spec>` (`option+z`, `option+space`, …) if you ever need a different one; the key code and modifiers a run used are recorded in its `results.json`.
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

This is the **v1** fingerprint and it stays exactly as it is: it covers the whole
ordered pool *including* the reserved warmups, it is taken over `ManifestEntry.id`, and
every recorded offset in `results/` indexes into that ordering. It is never compared
with the v2 `fingerprintV2`, which covers the clips one run measured with the warmups
**excluded**. See [Benchmark v2](#benchmark-v2-clip-identity-honest-cursors-and-one-contract),
and note that the identity a v2 measurement is keyed on is `clipId`, not `id`.

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
| `--from N` | **Explicit start index** into the consumable range, overriding each dataset's cursor for this run only. Index 0 is the first clip after the three reserved warmups. Needs `--samples` or `--to`. See [Re-measuring clips already measured](#re-measuring-clips-already-measured---from). |

`--samples` and `--to` are mutually exclusive. Warmups are outside both counts:
`--samples 4` plays seven clips per dataset and scores four.

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

## The same command in both harnesses

Two repositories measure the same clips against the same ordered manifests: this one, and `codictate` next door. The flags line up on purpose, so one command shape works in both.

| | `dictation-product-benchmark` (one external product) | `codictate` (its own Speech Models) |
| --- | --- | --- |
| entry point | `bun run benchmark -- ...` | `bun run benchmark -- ...`, or the original `bun run bench:stt -- ...` |
| preview, run nothing | `--dry-run` | `--plan-only` |
| depth as a delta | `--samples N` | `--samples N` |
| depth as a target | `--to N` | `--to N` |
| explicit start index | `--from N` | `--from N` |
| dataset choice | `--datasets test-clean,hu_hu` | `--splits test-clean` and `--languages hu_hu` |
| run name | `--name <slug>`, required for a new run | `--name <slug>`, required unless `--plan-only` |
| free-text note | `--configuration-note` or `--description` | `--description` or `--configuration-note` |
| model choice | none: the product is the subject | `--models <ids>`; omitting it opens the interactive picker |

Both spellings of the note flag are accepted in both repositories, so neither has to be retyped. Two differences are real and stay:

- **`codictate` requires the note, this repository does not.** `codictate` writes it to `description` in `stt.json`, and the website renders that string as the run page's `<title>`, its meta and OpenGraph description, and the page lede. A blank one would publish a run page whose `<title>` opens on the separator with nothing in front of it, and an empty meta description, so it stays required rather than defaulted. `--plan-only` needs neither `--name` nor `--description`.
- **`codictate` has an interactive picker, this repository has nothing to pick.** A multi-model harness offers a model list when `--models` is absent; a single-product harness has one subject. `--from` is refused on the picker path in `codictate`, because the picker only offers a delta from each cursor and would overwrite a typed depth.

### Re-measure the same 400 clips I already measured

```bash
# dictation-product-benchmark
bun run benchmark -- --name verify-timing-fix \
  --description "Re-measure clips 1-400 to isolate the timing fix" \
  --datasets hu_hu --from 0 --samples 400

# codictate
bun run benchmark -- --name verify-timing-fix \
  --description "Re-measure clips 1-400 to isolate the timing fix" \
  --models large-v3-q5_0 --splits none --languages hu_hu --from 0 --samples 400
```

Both print the same rewind line, differing only in the model prefix `codictate` needs:

```
  hu_hu: REWIND cursor 397 -> --from 0 (re-measuring clips 1-400 of 902 consumable, 397 of them already measured; cursor ends at 400, never lower than 397)
  [large-v3-q5_0] hu_hu: REWIND cursor 397 -> --from 0 (re-measuring clips 1-400 of 902 consumable, 397 of them already measured; cursor ends at 400, never lower than 397)
```

Add `--dry-run` (here) or `--plan-only` (`codictate`) to see that line and spend nothing.

## Re-measuring clips already measured: `--from`

`--samples` and `--to` can only push a cursor forward, which is what makes them safe
and what makes them useless for one job: **verifying a fix in isolation**. If a change
moves Hungarian WER from 22.9% to 21.4%, the cursor guarantees the second measurement
used *different clips*, so the difference could be the fix or could be the sample.

`--from N` is the answer. It is an **explicit start index into the consumable range**,
overriding every cursor for that run only. Index 0 is the first clip after the three
reserved warmups, so `--from 0` starts at manifest entry 3. Nothing is written back,
no cursor is edited, and the run records the range it measured exactly like any other
run.

```bash
# Re-measure the same 400 clips this repository already measured
bun run benchmark -- \
  --name verify-timing-fix \
  --description "Re-measure clips 1-400 to isolate the timing fix" \
  --datasets hu_hu \
  --from 0 --samples 400
```

**`--from` needs a depth flag.** `--from N --samples M` measures M clips starting at N;
`--from N --to M` measures from N up to depth M. `--from 0 --samples 400` and
`--from 0 --to 400` name the identical 400 clips. `--from` on its own is rejected
rather than defaulting: it names a start and no end, and falling back to the default
`--samples 20` would pick a depth nobody asked for on the one path that re-spends clips
already paid for.

It is refused in three cases, each with its own message:

| Refused | Why |
| --- | --- |
| a negative index | `--from` is an index, not a count. `0` is legal; `-1` is not. |
| an index at or past a dataset's consumable count | Clamping is what would make this dangerous: `--from 5000` on the 902-clip `hu_hu` pool would measure nothing and record depth 902. The message names the dataset and its count: `--from 5000 is out of range for test-clean: it has 2617 consumable clips, so the valid --from indices are 0-2616.` |
| combined with `--resume` | A resumed run already recorded the range it was measuring and carries the clips it finished from that range. Rewinding it to a different start would file those clips against a range they do not belong to. |

### The plan preview names a rewind

A rewind is the one genuinely destructive path here, so its preview line is not the
ordinary line with different numbers. The arrow runs backwards, the flag is named
beside the cursor it overrode, and the clips about to be spent a second time are
counted out.

```
From:      --from 0 (explicit start into the consumable range; the cursor is ignored for this run only)
           REWIND: 5 datasets will re-measure clips already measured. Nothing is deleted and no cursor moves backwards; the same clips are simply run again.
...
Plan:
  test-clean: REWIND cursor 397 -> --from 0 (re-measuring clips 1-400 of 2617 consumable, 397 of them already measured; cursor ends at 400, never lower than 397)
  hu_hu: REWIND cursor 397 -> --from 0 (re-measuring clips 1-400 of 902 consumable, 397 of them already measured; cursor ends at 400, never lower than 397)
```

Compare the same depth without `--from`, which is the shape every other run prints:

```
Plan:
  test-clean: cursor 397 -> 797 (clips 398-797 of 2617 consumable, 1820 remaining after)
  hu_hu: cursor 397 -> 797 (clips 398-797 of 902 consumable, 105 remaining after)
```

A `--from` that starts *past* a cursor is not a rewind, but it is flagged too, because
it would record a depth over clips nobody measured:

```
  hu_hu: GAP --from 500 starts past cursor 397 (clips 501-600 of 902 consumable, leaving clips 398-500 unmeasured; cursor ends at 600)
```

### A rewind never lowers a cursor

The cursor for a dataset is the **maximum `endIndex` over every run in `results/`**
whose fingerprint matches (`deriveCursors` in `src/selection.ts`), so a rewound run is
recorded like any other and the maximum does the rest:

- re-measuring `[0, 400)` while the cursor reads 397 leaves the cursor at **400**
- re-measuring `[0, 200)` while the cursor reads 397 leaves it at **397**, untouched

The earlier run is not rewritten, nothing subtracts, and no clip is lost. `--from` is
deliberately not serialised into `config`: the instruction is about where to start, and
the range it produced is already in that dataset's `selection` record.

### Worked example: verifying a fix by re-measuring the same range

The committed run left every dataset at cursor 397, and scored 22.93% WER on `hu_hu`.
A timing fix lands. To attribute a change to the fix rather than to a different sample:

```bash
# 1. Read off exactly which clips will be spent, and spend nothing.
bun run benchmark -- --name verify-timing-fix --datasets hu_hu --from 0 --to 397 --dry-run
#   hu_hu: REWIND cursor 397 -> --from 0 (re-measuring clips 1-397 of 902 consumable, 397 of them already measured; cursor ends at 397, never lower than 397)

# 2. Re-measure the identical 397 clips. `--to 397` rather than `--samples 397` so the
#    range matches the recorded one exactly, whatever the cursor happens to be.
bun run benchmark -- \
  --name verify-timing-fix \
  --description "Clips 1-397 again, after the timing fix" \
  --datasets hu_hu \
  --from 0 --to 397

# 3. Both runs now record selection {startIndex: 0, endIndex: 397} against the same
#    fingerprint, so the two WERs are the same 397 clips and the delta is the fix.
#    The cursor is still 397: nothing was consumed and nothing was lost.
bun run benchmark -- --name next --datasets hu_hu --samples 400 --dry-run
#   hu_hu: cursor 397 -> 797 (clips 398-797 of 902 consumable, 105 remaining after)
```

Two runs at equal depth is a real case downstream, and it is resolved in favour of the
newer one: the website's benchmark reader gives an **equal-depth tie to the newer
`runDate`**, so the re-measured run is the one that renders.

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

**That second step has been taken, as a filter rather than as silence.** See
[Speed is published again, with a stated exclusion](#speed-is-published-again-with-a-stated-exclusion):
`stt.json` carries a nested `speed` block, and a clip that cannot prove which clock and
which key edge produced its number is excluded from the pooled ratio and counted in
`speed.speedExcludedCount`. Every clip in this run is excluded, so every dataset
publishes `responseMsPerAudioSec: null` beside the count that explains the null. The
five flat fields named above stay gone and are not renames of anything in that block.

The output-device restore was not the only thing wrong with this run's window. Both
hotkey edges were stamped *after* `post(hotkey)` returned, which also excluded the
50 ms Z hold and the 20 ms Option-release settle — **81 to 90 ms per clip**, measured,
in Flow's favour. Both edges are now stamped at the Z key-down transition inside the
posting routine, on a monotonic clock, and the record says so.

## Benchmark v2: clip identity, honest cursors, and one contract

Everything above describes the v1 harness, and every word of it is still true of the
v1 records in `results/`. This section is what changed for **benchmark v2**, the
cross-repository contract that makes a Wispr Flow number and a Codictate number
comparable.

The prose contract is
[`../codictate/docs/BENCHMARK_CONTRACT.md`](../codictate/docs/BENCHMARK_CONTRACT.md)
and it is the document to read first. The code it describes lives in
`../codictate/benchmarks/contract/` and is **mirrored** into `src/contract/` here —
`src/contract/index.ts` explains why a mirror rather than an import, and
`tests/contract.test.ts` plus `tests/contract-parity.manual.ts` are what keep the
mirror honest.

### `clipId`: which audio file a number is about

A measurement is now located by the audio file's corpus-relative POSIX path, relative
to `<codictate>/benchmarks/datasets`:

```
fleurs/da_dk/audio/test/12149430079508542992.wav
librispeech/wav/test-clean/1272-128104-0000.wav
```

That exact string was already being written into every committed record by
`portableAudioPath`, which is why it was chosen rather than invented.

**FLEURS identity is TSV column 1, never column 0.** Column 0 is the *sentence* id and
it repeats — FLEURS records several speakers per sentence — so Danish has 930 clips
behind 350 distinct column-0 values, Spanish 908 behind 348, Hungarian 905 behind 348
(measured; `tests/fleurs-identity.manual.ts` pins all of it). The v1 harness built its
entry id from column 0 and deduplicated its already-captured set on it, so a planned
400-clip Danish range invoked Flow on **264** distinct audio files and recorded a depth
of 400 regardless. `results/20260902_181511_wispr-flow-all-400` shows it: `endIndex:
397` for `da_dk` against 264 distinct ids.

Column 0 survives as `sentenceId` metadata. `ManifestEntry.id` also survives, because
the v1 `manifestFingerprint` is taken over it and every recorded `selection` offset
indexes into that ordering — but nothing keys on it any more.

### The cursor is the contiguous measured prefix

`selection` records now carry three numbers where they used to carry one:

| Field | Meaning |
| --- | --- |
| `endIndex` | Where this run's own range reached. |
| `contiguousEndIndex` | The **production cursor**: the contiguous measured prefix. A gap does not advance it. |
| `maxMeasuredEndIndex` | One past the deepest measured clip, **gaps included. Not a cursor and not a depth.** |

`--from 600` on a cursor of 397 used to record a cursor of 900, so the next run started
at 900 and clips 398-600 were skipped for ever with nothing published showing it. The
`GAP` preview line now reads:

```
hu_hu: GAP --from 500 starts past cursor 397 (clips 501-600 of 902 consumable, leaving
clips 398-500 unmeasured; cursor ends at 397, unmoved because the prefix stops at the
hole; maxMeasuredEnd 600, not contiguous and not a depth)
```

**Only completed runs feed the cursor.** A run's status is explicit on its record, a
missing status reads as incomplete, and an unfinished run contributes nothing — not
even the clips it finished. Starting a new run that **overlaps a compatible incomplete
run** is refused, naming the run id to resume or discard.

### Resume is explicit, and it replays the warmups

`--resume` takes a run id or a run directory and **never searches for the latest
unfinished run**: that search resumes the wrong run silently. It re-reads the immutable
Run Plan written before the first clip, and it refuses all thirteen
selection-changing flags by name — `--from --to --samples --limit --clips-per-dataset
--dataset --datasets --languages --splits --model --models --seed --smoke`. `--batch`
and `--out` are deliberately allowed: they name the batch and where a report goes, not
what was measured.

The three reserved warmups replay on **every** resumed session, whatever the record
holds. Completed **scored** clips never repeat — including recorded `failed` and
`timeout` clips, which are counted measurements and are not replayed.

### Checkpointing

Atomic write after **every scored clip**, never batched: temporary file in the same
directory, `fsync`, then `rename` over the target. **Three** writes per clip —
`results.json`, `checkpoint.json`, and the dataset's v2 record under `v2/`. The Run Plan
under `plans/` is written once, before the first clip, and never again: that is what
makes it immutable.

### v2 run records

Alongside `results.json`, each run directory holds:

- `plans/<dataset>.json` — the immutable Run Plan, written once, refused if rewritten
  with a different fingerprint.
- `v2/<dataset>.json` — the per-clip `RunRecordV2` both repositories write, with
  `schemaVersion: 2`, an explicit `status`, and one `SampleMeasurementV2` per clip.

The v2 fingerprint is `fingerprintV2: { "version": "benchmark-v2", "value": "<16 hex>" }`
over the plan's **selected scored clips, warmups excluded**. That is deliberately the
opposite convention from the v1 `manifestFingerprint`, which covers the whole pool
*including* the warmups — the two are never compared and never migrated into one
another.

### Speed is published again, with a stated exclusion

`stt.json` leaves now carry a nested `speed` block: pooled
`responseMsPerAudioSec = sum(successful responseMs) / sum(successful audioDurationSec)`,
plus `wallRtf`, `medianResponseMs`, `p90ResponseMs`, `attemptedCount`,
`respondedCount`, `speedExcludedCount`, `failureCount` and `timeoutCount`.
`failureCount` includes timeouts and `timeoutCount` is the subset, so
`attemptedCount === respondedCount + failureCount` always holds.

The response metric is **`stopToLastTextChangeMs`**: the stop Z-keydown edge to the last
actual pasted-text change. `stopToStableTextMs` keeps its old meaning and **includes**
the 750 ms stability confirmation, so it is not a response time and nothing substitutes
one for the other.

**Every run recorded before 2026-09-04 is excluded from pooled speed.** Those clips were
stamped after `post(hotkey)` returned, which left out the 50 ms Z hold and the 20 ms
Option-release settle plus scheduler slop: **81 to 90 ms per clip, measured** (the Swift
test prints 79 ms on this machine), every millisecond of it in Flow's favour. A sample
without `hotkeyEdge: "keydown"` and `timingClock: "monotonic"` is not a v2 speed
measurement, so `speedCompatible` keeps it out of the ratio, the median and the p90, and
`speedExcludedCount` says how many were dropped. It stays readable, it still contributes
accuracy and coverage, and for `results/20260902_181511_wispr-flow-all-400` that means
every dataset publishes `responseMsPerAudioSec: null` beside the count that explains the
null. **This is why the existing Flow results must be rerun.**

### The publication batch orchestrator

One command measures the whole matrix and publishes nothing:

```bash
bun run benchmark:publication -- \
  --batch 2026-09-v2 \
  --from 0 \
  --to 400 \
  --flow-hotkey option+z
```

**It is self-sufficient.** One command: it preflights, downloads every Speech Model
weight it is missing, writes an **immutable shared batch manifest** — one fingerprinted
Run Plan per stage per dataset — and then runs the whole matrix. It does not need a
prior `--dry-run`, a prior `--smoke`, or a prior download step, and if it is interrupted
the **identical command** resumes it: no flags to change, no run ids to look up.

The matrix, **19 stages**, in production order:

1. **Wispr Flow** over all five datasets. First, because it is the product that can
   change underneath the measurement.
2. **Thirteen multilingual Codictate models** over the same five datasets, the same
   clips: `large-v3-q5_0`, `large-v3`, `large-v3-turbo`, `large-v3-turbo-q5_0`,
   `large-v3-turbo-q8_0`, `parakeet-tdt-0.6b-v3`, `large-v1`, `large-v2`,
   `large-v2-q5_0`, `large-v2-q8_0`, `medium`, `medium-q5_0`, `medium-q8_0`.
3. **Five Danish-pinned hviske models** over `da_dk` only: `-f16`, `-q8_0`, `-q6_k`,
   `-q5_0`, `-q4_k`. They transcribe as Danish whatever they are handed, so an English
   split would measure Danish decoding of English speech rather than the model. They are
   not a second ASR Harness — `HVISKE_ASR_HARNESS` is `crispasr` — so
   `compatibilityKey` needs no extra dimension for them.

At `--to 400` that is **30,000 scored clips**: 5 × 400 for Flow, 13 × 5 × 400
multilingual, 5 × 400 Danish.

Completed stages are skipped, an incomplete stage is resumed **by run id** — the
orchestrator resolves the id from the records itself, for both harnesses — and the first
failure stops the batch, because the stages share a clip set on purpose and a partial
matrix is a comparison with a hole in it. Per-stage state and a final readiness report go
under the batch directory. Nothing is published, nothing is deployed, and **downloaded
models are kept on disk**: `--offload-models` is never passed and nothing here deletes a
weight.

### Speech Model weights are fetched before the first clip

Eighteen models is roughly 20 GB of weights, and a typical machine has three of them.
`bench:stt` downloads lazily at the start of each stage, which is right for a
single-model run and wrong for a matrix: the night would die on stage sixteen because a
mirror was down, hours after the operator went to bed.

So the batch fetches **every** missing weight up front, sequentially, with a per-model
verdict, and refuses to measure anything until they are all on disk. The catalogue and
the downloader are read out of the Codictate checkout at runtime rather than copied, so
the sizes and artifact names are the ones the run will actually load.

A missing weight the batch *cannot* fetch is a hard preflight failure with the remedy:
`parakeet-tdt-0.6b-v3` is a Core ML bundle installed by the Codictate app, not a file
this step can download, and `bench:stt`'s own download step skips it for the same reason.

To pre-fetch separately — the one long step that can be done before committing an
evening — use `--download-models`. It is a convenience, not a prerequisite.

```bash
bun run benchmark:publication -- --batch 2026-09-v2 --download-models
bun run benchmark:publication -- --batch 2026-09-v2 --preflight-only
```

### How long it takes, and whether it fits one night

Measured, not guessed. Audio durations are summed from the manifests; the Flow ratio is
the archived 400-clip run's own wall clock (8.16 h over 5.51 h of audio = **1.482×**,
4.81 s of overhead per clip); each Codictate model's RTF is the pooled
`totalWallSec / totalAudioSec` from Codictate's own archive.

| Stage | Clips | Audio (h) | Est. (h) |
| --- | --- | --- | --- |
| Wispr Flow | 2000 | 5.55 | **8.2** |
| `large-v3` / `large-v1` / `large-v2` | 2000 each | 5.55 | 1.0 each |
| `large-v2-q8_0` / `large-v2-q5_0` | 2000 each | 5.55 | 0.85 / 0.81 |
| `medium` / `medium-q8_0` / `medium-q5_0` | 2000 each | 5.55 | 0.64 / 0.59 / 0.55 |
| `large-v3-q5_0` / `-turbo` / `-turbo-q8_0` | 2000 each | 5.55 | 0.60 each |
| `large-v3-turbo-q5_0` | 2000 | 5.55 | 0.38 |
| `parakeet-tdt-0.6b-v3` | 2000 | 5.55 | 0.11 |
| 5 × hviske (Danish only) | 400 each | 1.23 | ~0.02 each |

**Wispr Flow 8.2 h + Codictate 8.9 h ≈ 17.1 h**, plus ~0.25 h of warmup replays and
model loading, plus the ~17 GB download on a first run. **It does not fit one night.**

Split it, which the resume-and-skip behaviour makes safe:

- **Night one** runs the Flow stage (8.2 h) and as many Codictate stages as fit. It
  needs the machine left alone — the harness drives Flow's UI, so focus must not change.
- **Interrupt with Ctrl-C** whenever you need the machine back. The interrupted stage is
  checkpointed after every scored clip and marked incomplete.
- **Re-run the identical command.** Completed stages are skipped, the interrupted stage
  is resumed by run id, and nothing is re-transcribed. The Codictate stages need no
  keyboard and no focus, so they can run during a working day.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--batch <id>` | **required** | Names the immutable shared manifest. A second invocation reads it instead of rebuilding. |
| `--from <n>` | `0` | First consumable index, inclusive. |
| `--to <n>` | `400` | One past the last consumable index. |
| `--flow-hotkey <spec>` | `option+z` | Wispr Flow's dictation shortcut. |
| `--smoke` | false | The five-clip rehearsal chain. Writes to `results/smoke/<batch>/`. |
| `--clips-per-dataset <n>` | 5 under `--smoke` | States the depth as a count instead of `--to`. |
| `--out <dir>` | `results/` | The tree the batch lives under. |
| `--models <csv>` | all 18 (2 under `--smoke`) | Codictate models to measure. |
| `--download-models` | false | Fetch every missing weight and stop. A convenience; the batch command does it itself. |
| `--preflight-only` | false | Run the checks, print them, and stop. Fetches nothing. |
| `--datasets <csv>` | all five | Datasets to measure. |
| `--dry-run` | false | Print the exact stage plan and invoke no adapter. |

`--flow-hotkey` defaults to **Option+Z** (key code `6`), which is what Flow is
configured with and what SPEC §5 pins. It is the *only* default: `src/runner.ts` and the
orchestrator both read `DEFAULT_FLOW_HOTKEY` from `src/publication-hotkey.ts`, so they
cannot drift apart. Set Flow's Hands-free shortcut to whatever you pass — Flow exposes
no supported automation API, so nothing here can verify it, and the wrong value does not
error, it times out on every clip. The runs under `results/` used Option+Space; see
[Metrics and comparison rules](#metrics-and-comparison-rules).

`--dry-run` is the only thing that is safe to run to check a plan. It prints per-stage
clip counts, clipId fingerprints and a run/skip/resume decision per stage, invokes no
adapter, transcribes nothing and touches neither product. Its only side effect is the
batch manifest and its Run Plans, which are what make the printed plan reproducible.

#### The smoke chain

```bash
bun run benchmark:publication -- --batch <id> --smoke --clips-per-dataset 5
```

Five scored clips from each of the five datasets through Wispr Flow (25), the same 25
through `large-v3-q5_0`, then five Danish clips through `hviske-v5-tiny-q5_0`: 55 scored
clips, plus the reserved warmup replays, which happen normally. Re-running the identical
command skips every completed stage and transcribes zero scored clips.

`--smoke` rehearses **two** models, not the production matrix — 30,000 clips is not a
rehearsal, and a rehearsal that took a night would not get run. The smoke chain is
**optional**: the production command does not depend on it having been run. It exists
because rehearsing the chain end to end before spending 17 hours on it is cheap.

`results/smoke/` is **git-ignored** and excluded from the production cursor,
aggregation, coverage, staging and publication. The exclusion is a property of where the
run is rather than of a flag a reader has to remember to pass
(`src/v2-record.ts::isSmokePath`), and `tests/publication.test.ts` covers it.

### Manual tests

Two test files read the corpus or the sibling checkout, so they are `.manual.ts` and CI
never runs them. Run them by path when either changes:

```bash
bun test ./tests/fleurs-identity.manual.ts     # clip identity against the real corpus
bun test ./tests/contract-parity.manual.ts     # mirror vs canonical contract, function by function
```

## Metrics and comparison rules

- Audio always plays at 1.0×. Core Audio/BlackHole stays real-time.
- Source identity and order match Codictate's seed-42 manifests.
- Failed or timed-out clips score as empty hypotheses, matching Codictate failure scoring.
- Aggregate WER excludes the three replayed warmups per dataset. Warmups are the reserved head of the ordered manifest and are never part of a consumable range, so they are neither scored nor counted as measured.
- Every run records the consumable range and manifest fingerprint it measured, per dataset, under `results.<dataset>.selection`. Two runs of the same dataset with non-overlapping ranges measured disjoint clips and can be pooled; the same range twice cannot happen unless a `results/` directory was edited by hand.
- Exact output remains preserved alongside normalized WER operations. FLEURS also receives Codictate-compatible CER against raw transcript.
- `stt.json` exposes the same `wer`, `cer`, `meanRTF`, `utteranceCount`, `totalAudioSec`, and `totalWallSec` fields as Codictate. `peakRSS_MB` is `null` because process memory is not meaningful for a managed external product.
- WER and CER are directly comparable when conditions match. Speed is comparable only through the pooled `speed` block described in [Benchmark v2](#speed-is-published-again-with-a-stated-exclusion), and only for clips that carry v2 timing provenance; a run made before 2026-09-04 publishes `responseMsPerAudioSec: null`. `meanRTF` remains on the leaf because it is what the harness clocked, but it is floored at 1.0 by playback the harness chose to do and is not comparable with Codictate's inference RTF or with anything else.
- Any surface that shows both products must print, character for character: *"Response times are not measured the same way for both products: Codictate is timed at the direct adapter call boundary, Wispr Flow is timed from the UI-observed paste."* It is one exported constant (`src/contract/timing.ts::INSTRUMENTATION_ASYMMETRY_LABEL`) because three surfaces in two repositories have to say the same thing, and `stt.json` carries it as `instrumentationNote`.
- `stopToLastTextChangeMs` is **the response metric**. `stopToStableTextMs` includes the 750 ms stability confirmation and is not a response time; nothing substitutes one for the other. Both remain in rich `results.json`, with `stopToFirstTextMs`, `stopToFirstTextHarnessMs`, `outputDeviceRestoreMs`, `startToStopMs`, `textChangeSource`, `textChangeCount`, `textChangeBiasMs`, `stabilityDelayMs`, `timingClock` and `hotkeyEdge` beside them.
- The poll interval is a bias term **only when `textChangeSource` is `"poll"`**. The bridge stamps text changes from the receiver's `NSTextStorage` notification, so on the event path `textChangeBiasMs` is `0`; polling is the documented fallback and states the whole interval as its bias. Read [Response time](#response-time-and-why-no-speed-figure-comes-out-of-the-committed-run) before deriving a speed figure from a run recorded before 2026-09-04: those runs restored the default output device inside the measured window.
- If a future run does publish one, state alongside it that Flow streams audio while the user is still speaking, so part of its transcription overlaps with speech and is invisible here, and that the figure is the wait after stopping rather than Flow's total compute.
- The runs under `results/` were measured with **Option+Space** (key code `49`), which was the default at the time. That is one of the two reasons they are not v2-comparable on speed; the other is the ~85 ms keydown-edge bias the bridge has since fixed. The current default is **Option+Z** and there is no fallback to the old one — a second default would let a direct invocation post a shortcut Flow no longer listens on and produce four hundred timeouts instead of an error. The archived records are untouched and still say what they used.
- Compare same clip IDs, language configuration, date window, machine, and repeat count. Flow service/model changes require new versioned runs.
- A figure pooled across sessions must disclose the Flow versions it spans. The cursor is per product, not per product version, precisely because Flow auto-updates and a per-version cursor would never accumulate; the compensation is that `product.version` is recorded per run, so the version mix behind a pooled number is always recoverable and must be stated.

## Checks

```bash
bun run check          # tsc --noEmit && bun test && swift build -c debug --package-path native
```

Run the type check through `rtk proxy` — or check its exit code — rather than trusting
filtered output: `rtk`'s output filter has rendered a failing `tsc` as "No errors
found", with a real `TS2688` behind it.

```bash
rtk proxy npx tsc --noEmit;                        echo "exit $?"
rtk proxy bun test;                                echo "exit $?"
rtk proxy swift build -c debug   --package-path native; echo "exit $?"
rtk proxy swift build -c release --package-path native; echo "exit $?"
rtk proxy swift test --package-path native;         echo "exit $?"
```

Full feasibility research and primary sources: [docs/WISPR_FLOW_BENCHMARK_FEASIBILITY.md](docs/WISPR_FLOW_BENCHMARK_FEASIBILITY.md).
