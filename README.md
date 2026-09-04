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

## Validate dataset plan

Dry run touches neither Flow nor result files:

```bash
bun run benchmark -- \
  --name english-smoke \
  --datasets test-clean \
  --samples 20 \
  --dry-run
```

Defaults reference `../codictate/benchmarks/datasets`. Override checkout location with `--codictate /absolute/path/to/codictate`.

## Run Wispr Flow benchmark

Run 20 samples from every dataset (100 clips total):

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

Runner opens **Dictation Benchmark Receiver**. Do not change focus while run is active. Each dataset's first three clips are warmups, matching Codictate's current benchmark behavior; remaining clips contribute aggregate WER.

After separate English and Danish smoke runs pass, larger example:

```bash
bun run benchmark -- \
  --name wispr-flow-english-200 \
  --datasets test-clean,test-other \
  --samples 200 \
  --configuration-note "Flow version recorded in results; English only; Context Awareness off"
```

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
- Aggregate WER excludes three warmups per dataset.
- Exact output remains preserved alongside normalized WER operations. FLEURS also receives Codictate-compatible CER against raw transcript.
- `stt.json` exposes the same `wer`, `cer`, `meanRTF`, `utteranceCount`, `totalAudioSec`, and `totalWallSec` fields as Codictate. `peakRSS_MB` is `null` because process memory is not meaningful for a managed external product.
- WER and CER are directly comparable when conditions match. Speed is not: `stt.json` publishes no speed or latency aggregate at all. `meanRTF` remains on the leaf because it is what the harness clocked, but it is floored at 1.0 by playback the harness chose to do and is not comparable with Codictate's inference RTF or with anything else.
- Stop-to-first-text and stop-to-stable-text remain in rich `results.json` for product latency analysis, with `stopToFirstTextHarnessMs` and `outputDeviceRestoreMs` beside them. Read [Response time](#response-time-and-why-no-speed-figure-comes-out-of-the-committed-run) before deriving a speed figure from a run recorded before 2026-09-04: those runs restored the default output device inside the measured window.
- If a future run does publish one, state alongside it that Flow streams audio while the user is still speaking, so part of its transcription overlaps with speech and is invisible here, and that the figure is the wait after stopping rather than Flow's total compute.
- Compare same clip IDs, language configuration, date window, machine, and repeat count. Flow service/model changes require new versioned runs.

## Checks

```bash
bun run check
```

Full feasibility research and primary sources: [docs/WISPR_FLOW_BENCHMARK_FEASIBILITY.md](docs/WISPR_FLOW_BENCHMARK_FEASIBILITY.md).
