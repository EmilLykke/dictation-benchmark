import { resolve } from "node:path";
import { NativeBridge } from "../native-bridge";
import type { ProductAdapter, PreflightResult, TranscriptionRequest, TranscriptionResult } from "../types";

export class AppleDictationAdapter implements ProductAdapter {
  private readonly bridge: NativeBridge;

  constructor(bridgePath = resolve(import.meta.dir, "../../native/.build/release/Apple Dictation Receiver.app/Contents/MacOS/flow-bridge")) {
    this.bridge = new NativeBridge(bridgePath);
  }

  async metadata() {
    const os = Bun.spawnSync(["sw_vers", "-productVersion"]);
    return { id: "apple-dictation", label: "Apple Dictation", version: os.exitCode === 0 ? new TextDecoder().decode(os.stdout).trim() : null };
  }

  async preflight(deviceName: string): Promise<PreflightResult> {
    const result = await this.bridge.request<PreflightResult>({ command: "preflight", product: "apple-dictation", deviceName });
    if (result.receiverBundleIdentifier !== "com.codictate.benchmark.apple-receiver") {
      throw new Error("Apple Dictation needs its bundled receiver. Run bun run build:native, then retry.");
    }
    return result;
  }

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    return this.bridge.request({ command: "transcribe", product: "apple-dictation", ...request });
  }

  close(): Promise<void> {
    return this.bridge.close();
  }
}
