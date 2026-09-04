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

Runner writes two atomic progress files after every finished clip:

- `results.json` preserves every hypothesis, error operation, latency, and status. Resume uses this file.
- `checkpoint.json` mirrors Codictate's completed-dataset and in-progress aggregate layout. It is removed only after successful completion.

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

## Metrics and comparison rules

- Audio always plays at 1.0×. Core Audio/BlackHole stays real-time.
- Source identity and order match Codictate's seed-42 manifests.
- Failed or timed-out clips score as empty hypotheses, matching Codictate failure scoring.
- Aggregate WER excludes three warmups per dataset.
- Exact output remains preserved alongside normalized WER operations. FLEURS also receives Codictate-compatible CER against raw transcript.
- `stt.json` exposes the same `wer`, `cer`, `meanRTF`, `utteranceCount`, `totalAudioSec`, and `totalWallSec` fields as Codictate. `peakRSS_MB` is `null` because process memory is not meaningful for a managed external product.
- WER and CER are directly comparable when conditions match. Flow `meanRTF` covers the full real-time product path (lead-in, playback, cloud processing, and paste), while Codictate RTF covers offline inference; do not treat their speed values as equivalent workloads.
- Stop-to-first-text and stop-to-stable-text remain in rich `results.json` for product latency analysis.
- Compare same clip IDs, language configuration, date window, machine, and repeat count. Flow service/model changes require new versioned runs.

## Checks

```bash
bun run check
```

Full feasibility research and primary sources: [docs/WISPR_FLOW_BENCHMARK_FEASIBILITY.md](docs/WISPR_FLOW_BENCHMARK_FEASIBILITY.md).
