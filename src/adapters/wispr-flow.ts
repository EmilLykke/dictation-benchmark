import { resolve } from "node:path";
import type {
  PreflightResult,
  ProductAdapter,
  ProductMetadata,
  TranscriptionRequest,
  TranscriptionResult,
} from "../types";
import { NativeBridge } from "../native-bridge";

interface NativeMetadata {
  running: boolean;
  version: string | null;
}

export const MINIMUM_VIRTUAL_MIC_FLOW_VERSION = "1.6.580";

export function supportsVirtualMicrophone(version: string | null): boolean {
  if (!version) return false;
  const actual = version.split(".").map(Number);
  const minimum = MINIMUM_VIRTUAL_MIC_FLOW_VERSION.split(".").map(Number);
  for (let index = 0; index < Math.max(actual.length, minimum.length); index++) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export class WisprFlowAdapter implements ProductAdapter {
  private readonly bridge: NativeBridge;

  constructor(
    bridgePath = resolve(import.meta.dir, "../../native/.build/release/flow-bridge"),
  ) {
    this.bridge = new NativeBridge(bridgePath);
  }

  async metadata(): Promise<ProductMetadata> {
    const native = await this.bridge.request<NativeMetadata>({ command: "metadata" });
    return { id: "wispr-flow", label: "Wispr Flow", version: native.version };
  }

  preflight(deviceName: string): Promise<PreflightResult> {
    return this.bridge.request({ command: "preflight", deviceName });
  }

  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    return this.bridge.request({ command: "transcribe", ...request });
  }

  close(): Promise<void> {
    return this.bridge.close();
  }
}
