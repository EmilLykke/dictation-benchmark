import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest } from "../src/manifest";
import { repositoryChecks } from "../src/preflight";
import { manifestFingerprint, selectionFor, planDataset } from "../src/selection";
import { runPlanFor } from "../src/v2-plan";
import { buildRunRecordV2, saveRunRecordV2 } from "../src/v2-record";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function wav(): Buffer {
  const value = Buffer.alloc(44 + 16_000);
  value.write("RIFF", 0); value.writeUInt32LE(value.length - 8, 4); value.write("WAVE", 8);
  value.write("fmt ", 12); value.writeUInt32LE(16, 16); value.writeUInt16LE(1, 20);
  value.writeUInt16LE(1, 22); value.writeUInt32LE(8_000, 24); value.writeUInt32LE(16_000, 28);
  value.writeUInt16LE(2, 32); value.writeUInt16LE(16, 34); value.write("data", 36);
  value.writeUInt32LE(16_000, 40);
  return value;
}

test("preflight allows only current batch's exact incomplete Flow run", () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-batch-")); roots.push(root);
  const codictatePath = join(root, "codictate");
  const datasets = join(codictatePath, "benchmarks", "datasets");
  const audio = join(datasets, "fleurs", "da_dk", "audio", "test");
  mkdirSync(audio, { recursive: true });
  const rows: string[] = [];
  for (let index = 0; index < 8; index++) {
    const file = `${index}.wav`; writeFileSync(join(audio, file), wav());
    rows.push(`${index}\t${file}\traw\treference\tx`);
  }
  writeFileSync(join(datasets, "fleurs", "da_dk", "test.tsv"), `${rows.join("\n")}\n`);
  const entries = buildManifest(datasets, "da_dk");
  const selected = planDataset("da_dk", entries, 0, { kind: "target", to: 5 });
  const runId = "interrupted-flow";
  const resultsRoot = join(root, "results");
  mkdirSync(join(resultsRoot, runId), { recursive: true });
  writeFileSync(join(resultsRoot, runId, "results.json"), JSON.stringify({
    runId, status: "running", product: { id: "wispr-flow", version: null },
    results: { da_dk: { selection: selectionFor(selected, 1) } },
  }));
  const plan = runPlanFor({ runId, batchId: "mine", harness: "wispr-flow", model: "wispr-flow",
    dataset: "da_dk", entries, fromIndex: 0, toIndex: 5, createdAt: "2026-09-04T00:00:00Z" });
  saveRunRecordV2(join(resultsRoot, runId), "da_dk", buildRunRecordV2({
    plan, status: "incomplete", startedAt: "2026-09-04T00:00:00Z", completedAt: null, samples: [],
  }));
  expect(manifestFingerprint(entries)).toBe(selected.manifestFingerprint);

  const check = (batchId: string) => repositoryChecks({
    codictatePath, deviceName: "BlackHole 2ch", datasets: ["da_dk"], resultsRoot, batchId,
    minimumFreeBytes: 0,
  }).find((item) => item.id === "compatibility-state")!;
  expect(check("mine").status).toBe("ok");
  expect(check("other").status).toBe("failed");
  expect(check("other").detail).toContain(runId);
});
