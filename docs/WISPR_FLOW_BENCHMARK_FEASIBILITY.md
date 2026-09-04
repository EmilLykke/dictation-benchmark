# Wispr Flow benchmark feasibility on macOS

Date: 2026-09-02

## Decision

This is feasible. A working proof now plays existing benchmark WAVs through BlackHole, toggles Flow hands-free, captures pasted text, and scores it with Codictate-compatible WER. A four-clip `test-clean` run completed without failures on 2026-09-02; its one non-warmup sample scored 0% WER. This is integration proof, not a statistically useful accuracy result.

Implemented path:

1. Temporarily route macOS default output to user-installed BlackHole 2ch.
2. Start Flow hands-free with a configurable synthetic shortcut, play each WAV at 1.0x through `afplay`, stop Flow, and restore previous output device.
3. Capture Flow's `Cmd+V` insertion in a focused native `NSTextView` with a standard Edit/Paste menu.
4. Save each clip immediately and score through Codictate-compatible normalization, WER, and CER.
5. Ask Wispr for permission or guidance before a large automated run. Public documentation exposes user-facing hotkeys and UI, not a supported benchmark/automation API, and automated high-volume use may burden the cloud service.

Rough effort:

| Scope | Effort | Result |
| --- | ---: | --- |
| Manual proof | 30–60 minutes | Confirm Flow hears prerecorded audio and produces scoreable text |
| Scripted proof | 0.5–2 days | Run a small fixed sample, capture outputs, calculate WER |
| Repeatable harness | 3–7 days | Timeouts, retries, focus guards, version/config recording, run artifacts, robust scoring |

These estimates exclude waiting for vendor approval and running the corpus. Audio must be played in real time, so 10 hours of source audio takes at least 10 hours per repetition.

## Fit with this repository

The existing benchmark data is already suitable for virtual-microphone playback:

- `benchmarks/scripts/convert-audio.ts` converts LibriSpeech to 16 kHz mono WAV.
- `benchmarks/scripts/build-manifests.ts` already pairs every audio path with its reference transcript, language, stable ID, and duration.
- `benchmarks/stt/wer.ts` and `benchmarks/stt/normalize.ts` can score Flow output without duplicating the current WER rules.
- Current local data contains both LibriSpeech conditions plus Spanish, Danish, and Hungarian FLEURS audio.

At the current 200-file cap, those five conditions contain 1,000 played clips and about 2.77 hours of source audio: 24.4 minutes test-clean, 23.0 minutes test-other, 40.4 minutes Spanish, 37.1 minutes Danish, and 41.5 minutes Hungarian. Flow's processing and inter-sample guards make wall time longer; plan roughly 3.5–5+ hours per complete repetition until measured. Start with the proposed 20-clip proof rather than a full run.

## Why it works

Wispr Flow's current microphone picker allows a virtual or loopback device such as BlackHole to be selected under **Settings → General → Microphone → Change → Show other devices**. Virtual devices must be selected manually: Flow excludes them from Auto-detect and microphone ranking. A microphone change applies on the next dictation, without restart. [Wispr Flow: Connect and set up external audio devices](https://docs.wisprflow.ai/articles/8884408990-connect-and-set-up-external-audio-devices)

BlackHole is a macOS virtual loopback driver. Its documented routing model is exactly this use case: sending application selects BlackHole as output; receiving application selects BlackHole as input. BlackHole supports both Apple Silicon and Intel, common sample rates including 16, 44.1, and 48 kHz, and reports zero added driver latency. [BlackHole README](https://github.com/ExistentialAudio/BlackHole)

Loopback offers an even easier manual proof. Rogue Amoeba documents routing a prerecorded file player's audio through a virtual device into macOS Dictation, and its application-source routing can capture only the selected player instead of all system sound. [Loopback prerecorded-audio transcription guide](https://rogueamoeba.com/support/knowledgebase/?showArticle=LB-Transcription) and [Loopback application-source routing guide](https://www.rogueamoeba.com/support/knowledgebase/?showArticle=Loopback-ScreenRecording)

Flow's hands-free shortcut behaves as a toggle. On Mac its default is `Fn+Space`: first press starts capture; second press stops it and pastes the transcript into the active text field. Shortcuts are configurable, so the benchmark should assign an automation-friendly combination rather than synthesize the special Fn key. [Wispr Flow: Use Flow hands-free](https://docs.wisprflow.ai/articles/6391241694-use-flow-hands-free) and [Wispr Flow: supported hotkeys](https://docs.wisprflow.ai/articles/2612050838-supported-unsupported-keyboard-hotkey-shortcuts)

## Proposed harness

```text
existing WAV + reference text
              |
              v
  real-time Core Audio player -----> BlackHole 2ch output
                                           |
                                           v
                                Flow microphone input
                                           |
                           hands-free start / stop hotkey
                                           |
                                           v
                            dedicated capture text field
                                           |
                                           v
                       existing normalization + WER scorer
```

### One-time setup

- Install BlackHole 2ch and restart as its installer requests. Keep BlackHole user-installed initially instead of bundling it. BlackHole is GPL-3.0 and its project states that non-GPL projects need a separate license; distribution needs a license review. [BlackHole README and licensing note](https://github.com/ExistentialAudio/BlackHole)
- In Flow, explicitly select **BlackHole 2ch** through **Show other devices**. Do not use Auto-detect.
- Configure a dedicated hands-free shortcut using ordinary modifiers and a key.
- Turn off Flow Context Awareness and keep capture field empty. Context Awareness is on by default and changes accuracy, style, capitalization, spacing, and punctuation based on active app and surrounding text. [Wispr Flow: Context Awareness](https://docs.wisprflow.ai/articles/4678293671-Context-Awareness)
- Fix language selection, style/formatting settings, personal/team dictionary state, Privacy Mode, Flow version, account, macOS version, and network environment. Record all of them in run metadata.
- Grant Accessibility permission to the harness so it can post keyboard events. macOS UI scripting and synthesized interaction require per-app Accessibility authorization. [Apple: Automating the user interface](https://developer.apple.com/library/archive/documentation/LanguagesUtilities/Conceptual/MacAutomationScriptingGuide/AutomatetheUserInterface.html) and [Apple: `CGEvent`](https://developer.apple.com/documentation/coregraphics/cgevent)

### Per sample

1. Focus and clear a text field owned by a tiny native capture app.
2. Start Flow hands-free with a synthesized shortcut.
3. Wait a fixed lead-in, proposed 500 ms.
4. Play one benchmark WAV at 1.0× speed to BlackHole 2ch.
5. Wait a fixed tail, proposed 300–500 ms.
6. Send the same hands-free shortcut to stop Flow.
7. Wait until text arrives or a timeout expires.
8. Store pasted output, reference, audio path, timing, Flow/app configuration, and failure status.
9. Feed output through the existing benchmark normalization and WER calculation.

Lead-in matters. Flow documents that it discards a small amount of audio at the start of every recording and recommends pausing briefly before speech. [Wispr Flow: Missing first words](https://docs.wisprflow.ai/articles/3566082841-fix-missing-first-words-in-transcriptions)

Current proof temporarily changes system output to BlackHole before starting Flow, keeps that route through recording stop, then restores the previous device. It therefore routes every system sound into Flow and silences speakers during each clip. Disable Flow sound effects and notifications. A future AUHAL player could target BlackHole directly without changing system output, but the first AVAudioEngine implementation returned successful playback timing while emitting digital silence and was rejected by a direct loopback recording. BlackHole documents default-output behavior; Apple requires matching sample rates and drift correction for unsynchronized aggregate devices. [BlackHole routing guide](https://github.com/ExistentialAudio/BlackHole/wiki/Getting-Started%3A-Sending-System-Audio-to-BlackHole/fda6278a3fb77a4f45aea47f178cc83aa011787f) and [Apple Audio MIDI Setup guide](https://support.apple.com/en-gb/guide/audio-midi-setup/ams094c7edb4/mac)

## Output capture

Use a dedicated native text field, not Terminal, browser content-editable UI, or clipboard-only capture.

- Flow officially pastes completed hands-free output into the active text field. [Wispr Flow: Use Flow hands-free](https://docs.wisprflow.ai/articles/6391241694-use-flow-hands-free)
- A harness-owned `NSTextView` gives direct, deterministic access to inserted text and an unambiguous completion signal. It must expose a standard Edit/Paste menu: without one, Flow's `Cmd+V` insertion fails with the macOS alert sound even when the text view is focused.
- Focus must remain on that field through stop/paste. Flow's troubleshooting guide confirms insertion depends on focused-field and clipboard behavior. [Wispr Flow: Fix text not pasting](https://docs.wisprflow.ai/articles/7971211038-fix-text-not-pasting-after-dictation)
- Avoid Terminal because Secure Keyboard Entry can prevent global shortcuts from being observed.
- Keep **Paste last transcript** as recovery only. Recovery paths should be marked as retries, not silently counted as normal runs.

No supported desktop CLI, local API, URL scheme, or automation endpoint for starting dictation or selecting a microphone was found in Wispr's public documentation. Treat hotkey/UI automation as integration testing: workable, but vulnerable to app updates.

## What this benchmark measures

It measures Wispr Flow as a product, not isolated ASR:

- audio acquisition through Flow;
- cloud transcription;
- Smart Formatting and self-correction cleanup;
- language detection/selection;
- paste/insertion behavior;
- network and service latency.

Flow says it captures the whole utterance, then transcribes and cleans filler words, punctuation, and self-corrections; internet access is required. [Wispr Flow: What is Flow?](https://docs.wisprflow.ai/articles/2772472373-what-is-flow) Its troubleshooting material also distinguishes raw transcription from formatting and documents automatic retry behavior. [Wispr Flow: Retry failed transcriptions](https://docs.wisprflow.ai/articles/2503460374-retry-failed-transcriptions)

Consequences:

- Existing WER remains useful, but punctuation/casing normalization is essential.
- Comparisons against Codictate's local ASR harness are product-level, not model-level.
- Report both accuracy and end-to-end latency: audio duration, stop-to-paste latency, total failures, retries, and timeout rate.
- Cloud models may change without a local code change. Every result must record Flow version, date/time, region/network, account/config, and repeat count.
- Personalization can make account state and sample order matter. Use a dedicated account with a frozen dictionary; randomize sample order; run repeated samples to estimate variance.
- Flow requires internet and can experience server timeouts/load. [Wispr Flow: transcription and connection errors](https://docs.wisprflow.ai/articles/4984532368-fix-taking-longer-than-usual-and-transcription-errors)
- Flow desktop sessions have a 20-minute maximum, but one session per utterance stays well below it. [Wispr Flow: Use Flow hands-free](https://docs.wisprflow.ai/articles/6391241694-use-flow-hands-free)

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Flow misses beginning/end | Fixed lead/tail silence; verify first-word sentinel during POC |
| Notification ping leaks into virtual mic | Target only player output via Core Audio or Loopback; disable Flow sound effects |
| Wrong microphone selected | Preflight Flow's “Mic in use” label; fail closed if BlackHole absent |
| Focus changes before paste | Harness owns frontmost window; verify focused `NSTextView` before start and stop |
| Cloud/API delay | Explicit stop-to-paste timeout; preserve failure type; bounded retry policy |
| Formatting changes WER | Use existing normalization; separately retain exact output and optionally CER |
| Context/personalization contaminates run | Dedicated blank receiver, Context Awareness off, frozen account/settings |
| Service update changes result | Record app version/date and use repeated anchor samples |
| Large run violates expected service use | Start small; rate-limit to real time; ask Wispr before corpus-scale automation |
| BlackHole redistribution obligations | Keep external for POC; obtain licensing advice before bundling |

Wispr's enterprise agreement expressly forbids unauthorized bot access, unreasonable burden, bypassing limits, and model extraction; consumer terms also forbid using AI output to develop or improve AI models. This project is evaluation rather than training, but permission is prudent before scaling or publishing a competitive benchmark. [Wispr Master Services Agreement](https://wisprflow.ai/legal/msa) and [Wispr Terms of Service](https://wisprflow.ai/terms-of-service)

## Suggested proof acceptance criteria

Use 10 English and 10 Danish clips already present under `benchmarks/datasets`, spanning short/long and clean/noisy examples.

Proof succeeds when:

- all 20 files reach Flow through virtual input without manual intervention after setup;
- at least 19/20 runs produce captured text rather than timeout/error;
- exact source audio, reference, output, timings, retry status, and configuration are saved;
- rerunning five anchor clips produces explainable/stable normalized scores;
- no Flow/system sounds enter captured input;
- system audio settings are restored after failure or normal exit.

If this passes, integrate it as a separate external-product harness rather than another Codictate ASR Harness. Repository architecture defines current ASR Harnesses as local executables used by Codictate; Flow is a cloud-backed UI product with different controls, failure modes, and metrics.
