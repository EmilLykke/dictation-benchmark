import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const build = Bun.spawnSync(["swift", "build", "-c", "release", "--package-path", "native"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) process.exit(build.exitCode);

// Dictation receives the shortcut in an unbundled process but never starts
// listening. Give its input-method client a stable application identity.
const release = join(root, "native/.build/release");
const contents = join(release, "Apple Dictation Receiver.app/Contents");
mkdirSync(join(contents, "MacOS"), { recursive: true });
copyFileSync(join(release, "flow-bridge"), join(contents, "MacOS/flow-bridge"));
copyFileSync(join(root, "native/AppleDictationReceiver-Info.plist"), join(contents, "Info.plist"));
console.log("Built Flow bridge and Apple Dictation Receiver.app");
