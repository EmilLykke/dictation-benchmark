// Integration check: builds must produce an app-bundled Apple input-method client.
// Run explicitly; it briefly opens receiver windows but never sends a shortcut.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { AppleDictationAdapter } from "../src/adapters/apple-dictation";

const bare = new AppleDictationAdapter(resolve(import.meta.dir, "../native/.build/release/flow-bridge"));
try {
  await assert.rejects(() => bare.preflight("BlackHole 2ch"), /needs its bundled receiver/);
} finally {
  await bare.close();
}

const bundled = new AppleDictationAdapter();
try {
  await bundled.preflight("BlackHole 2ch");
} finally {
  await bundled.close();
}
console.log("PASS: bare receiver rejected; bundled Apple receiver accepted");
