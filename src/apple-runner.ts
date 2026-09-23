import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { arch, cpus } from "node:os";
import { AppleDictationAdapter } from "./adapters/apple-dictation";
import { buildManifest } from "./manifest";
import { datasetsRoot } from "./portable-paths";
import { parseHotkey } from "./publication-hotkey";
import { computeWer, computeCer } from "./scoring";
import { WARMUP_COUNT } from "./selection";
import { DATASET_IDS, type DatasetId, type ManifestEntry } from "./types";

const HELP = `Experimental Apple Dictation accuracy benchmark

bun run benchmark:apple -- --dataset da_dk --locale da-DK --samples 5

Options:
  --dataset ID          One dataset (default test-clean)
  --locale LOCALE       Selected Apple locale (default en-US)
  --samples N           Scored clips (default 5)
  --from N              Offset after reserved warmups (default 0)
  --hotkey SPEC         Dictation shortcut (default option+x)
  --lead-ms N           Unverified activation wait (default 2000)
  --tail-ms N           Silence before Escape (default 500)
  --stable-ms N         Post-stop stability wait (default 2000)
  --timeout-ms N        Post-stop deadline (default 45000)
  --device NAME         Dictation microphone (default BlackHole 2ch)
  --processing-mode MODE  on-device, server, or unknown (default unknown)
  --configuration-note TEXT  Record punctuation and other manual settings
  --codictate PATH      Dataset checkout (default ../codictate)
  --out PATH            New output directory; existing paths refused
  --dry-run             Show selected clips without native bridge
  --preflight           Check bridge/audio/Accessibility without dictating

Before a real run: enable Dictation, select the stated locale and microphone,
set the matching shortcut, turn Voice Control off, and quit competing dictation
apps. Keep the receiver focused. Settings are operator-supplied, not verified.
Results are experimental, accuracy-only, and excluded from publication/cursors.
`;

export function parseAppleArgs(args: string[]) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const known = new Set(["--dataset", "--locale", "--samples", "--from", "--hotkey", "--lead-ms", "--tail-ms", "--stable-ms", "--timeout-ms", "--device", "--processing-mode", "--configuration-note", "--codictate", "--out"]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--") continue;
    if (["--help", "--dry-run", "--preflight"].includes(flag)) { switches.add(flag); continue; }
    if (!known.has(flag)) throw new Error(`Unknown option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    values.set(flag, value);
  }
  const number = (flag: string, fallback: number, minimum = 0) => {
    const raw = values.get(flag) ?? String(fallback);
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < minimum) throw new Error(`Invalid ${flag}: ${raw}`);
    return n;
  };
  const dataset = (values.get("--dataset") ?? "test-clean") as DatasetId;
  if (!DATASET_IDS.includes(dataset)) throw new Error(`Unknown dataset: ${dataset}`);
  const locale = values.get("--locale") ?? "en-US";
  const language = dataset.startsWith("test-") ? "en" : dataset.split("_")[0];
  if (!new RegExp(`^${language}-[A-Z]{2}$`).test(locale)) throw new Error(`Choose an explicit ${language} region locale for ${dataset}, e.g. ${language === "es" ? "es-MX" : language === "da" ? "da-DK" : language === "hu" ? "hu-HU" : "en-US"}`);
  const processingMode = values.get("--processing-mode") ?? "unknown";
  if (!["on-device", "server", "unknown"].includes(processingMode)) throw new Error("Invalid --processing-mode");
  const stableMs = number("--stable-ms", 2000, 1);
  const timeoutMs = number("--timeout-ms", 45000, 1);
  if (timeoutMs <= stableMs) throw new Error("--timeout-ms must exceed --stable-ms");
  return {
    dataset, locale, processingMode, stableMs, timeoutMs,
    samples: number("--samples", 5, 1), from: number("--from", 0),
    hotkey: parseHotkey(values.get("--hotkey") ?? "option+x"),
    leadMs: number("--lead-ms", 2000), tailMs: number("--tail-ms", 500),
    deviceName: values.get("--device") ?? "BlackHole 2ch",
    configurationNote: values.get("--configuration-note") ?? "",
    codictatePath: resolve(values.get("--codictate") ?? resolve(import.meta.dir, "../../codictate")),
    out: resolve(values.get("--out") ?? resolve(import.meta.dir, "../results/experimental/apple", new Date().toISOString().replace(/[:.]/g, "-"))),
    dryRun: switches.has("--dry-run"), preflight: switches.has("--preflight"), help: switches.has("--help"),
  };
}

export function applePlaylist(manifest: ManifestEntry[], from: number, count: number) {
  if (from + WARMUP_COUNT >= manifest.length) throw new Error("--from exceeds available scored clips");
  if (from + WARMUP_COUNT + count > manifest.length) throw new Error("Requested clips exceed available corpus; reduce --samples");
  return [
    ...manifest.slice(0, WARMUP_COUNT).map(entry => ({ entry, warmup: true })),
    ...manifest.slice(WARMUP_COUNT + from, WARMUP_COUNT + from + count).map(entry => ({ entry, warmup: false })),
  ];
}

async function main() {
  if (process.argv.includes("--help")) { console.log(HELP); return; }
  const config = parseAppleArgs(process.argv.slice(2));
  const playlist = config.preflight ? [] : applePlaylist(buildManifest(datasetsRoot(config.codictatePath), config.dataset), config.from, config.samples);
  console.log(`Apple Dictation: ${config.dataset}, ${config.locale}, ${config.samples} scored clips + ${WARMUP_COUNT} warmups`);
  console.log("Manual setup: Dictation enabled; matching locale, microphone and shortcut; Voice Control off; other dictation apps quit. Activation delay is unverified; speed is not scored.");
  if (config.dryRun) {
    for (const { entry, warmup } of playlist) console.log(`${warmup ? "warmup" : "score"} ${entry.clipId} (${entry.audioDurationSec.toFixed(2)}s)`);
    return;
  }
  const adapter = new AppleDictationAdapter();
  let interrupted = false;
  const interrupt = () => { interrupted = true; console.log("Stopping after current clip so Dictation and audio routing can be restored."); };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const preflight = await adapter.preflight(config.deviceName);
    console.log(preflight);
    const savedLocale = preflight.dictationLocalePreference?.replaceAll("_", "-");
    if (savedLocale && savedLocale !== config.locale) {
      console.warn(`WARNING: macOS saved Dictation locale is ${savedLocale}, but this run declares ${config.locale}. Select the matching language in macOS; --locale does not switch it. Saved preferences may lag the live session.`);
    }
    if (!preflight.outputDeviceFound) throw new Error(`Missing audio device: ${config.deviceName}`);
    if (!preflight.accessibilityTrusted) throw new Error("Grant Accessibility to terminal/flow-bridge under System Settings > Privacy & Security > Accessibility");
    if (config.preflight) { console.log("Machine checks passed. Dictation settings still require manual verification."); return; }
    const product = await adapter.metadata();
    const run = {
      format: "apple-dictation-experimental-v1", product, status: "running",
      createdAt: new Date().toISOString(),
      config: { ...config, codictatePath: "<codictate>", out: "<run-directory>", settingsVerified: false },
      machine: { arch: arch(), cpu: cpus()[0]?.model, osBuild: new TextDecoder().decode(Bun.spawnSync(["sw_vers", "-buildVersion"]).stdout).trim() },
      speedEligible: false,
      preflight,
      diagnostic: null as string | null,
      samples: [] as Array<Record<string, unknown>>,
      aggregate: { attempted: 0, succeeded: 0, wordErrors: 0, referenceWords: 0, wer: null as number | null },
    };
    mkdirSync(dirname(config.out), { recursive: true });
    mkdirSync(config.out);
    // Exclusive creation prevents overwriting a previous experiment.
    writeFileSync(join(config.out, "apple-results.json"), JSON.stringify(run, null, 2), { flag: "wx" });
    const save = () => {
      const file = join(config.out, "apple-results.json");
      writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2) + "\n");
      renameSync(`${file}.tmp`, file);
    };
    console.log(`Saving ${join(config.out, "apple-results.json")}`);
    try {
      for (const { entry, warmup } of playlist) {
        if (interrupted) break;
        const result = await adapter.transcribe({ audioPath: entry.audioPath, deviceName: config.deviceName, hotkey: config.hotkey, leadMs: config.leadMs, tailMs: config.tailMs, stableMs: config.stableMs, timeoutMs: config.timeoutMs, pollIntervalMs: 20 });
        const wer = computeWer(entry.transcript, result.transcript);
        run.samples.push({ clipId: entry.clipId, warmup, audioDurationSec: entry.audioDurationSec, reference: entry.transcript, hypothesis: result.transcript, wer, cer: computeCer(entry.rawTranscript ?? entry.transcript, result.transcript), observation: result });
        if (!warmup) {
          run.aggregate.attempted++;
          if (result.status === "ok") run.aggregate.succeeded++;
          run.aggregate.wordErrors += wer.substitutions + wer.insertions + wer.deletions;
          run.aggregate.referenceWords += wer.refWords;
          run.aggregate.wer = run.aggregate.referenceWords ? run.aggregate.wordErrors / run.aggregate.referenceWords : null;
        }
        save();
        console.log(`${warmup ? "warmup" : "score"} ${entry.clipId}: ${result.status}, WER ${(wer.wer * 100).toFixed(1)}%\n${result.transcript}`);
        if (result.status !== "ok") throw new Error(`Stopped after ${result.status}; inspect captured output and manual setup before retrying`);
      }
      run.status = interrupted ? "interrupted" : "completed";
      if (interrupted) process.exitCode = 130;
    } catch (error) {
      run.status = "failed";
      run.diagnostic = error instanceof Error ? error.message : String(error);
      throw error;
    } finally { save(); }
  } finally {
    await adapter.close();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
