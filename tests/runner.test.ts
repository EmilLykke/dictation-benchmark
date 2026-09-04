import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { DATASET_IDS } from "../src/types";

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
