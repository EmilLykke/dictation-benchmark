import {
  MINIMUM_VIRTUAL_MIC_FLOW_VERSION,
  supportsVirtualMicrophone,
  WisprFlowAdapter,
} from "./adapters/wispr-flow";

const deviceName = process.argv[2] ?? "BlackHole 2ch";
const adapter = new WisprFlowAdapter();

try {
  const [product, preflight] = await Promise.all([
    adapter.metadata(),
    adapter.preflight(deviceName),
  ]);
  const versionSupported = supportsVirtualMicrophone(product.version);

  console.log(`Wispr Flow running:  ${preflight.productRunning ? "yes" : "no"}`);
  console.log(`Wispr Flow version:  ${product.version ?? "unknown"}`);
  console.log(`Virtual mic release: ${versionSupported ? "yes" : `no (needs ${MINIMUM_VIRTUAL_MIC_FLOW_VERSION}+)`}`);
  console.log(`Output device:       ${preflight.outputDeviceFound ? `${deviceName} found` : `${deviceName} missing`}`);
  console.log(`Accessibility:       ${preflight.accessibilityTrusted ? "granted" : "missing"}`);
  if (!preflight.outputDeviceFound) {
    console.log(`Available outputs:   ${preflight.outputDevices.join(", ") || "none"}`);
  }

  if (!preflight.productRunning || !versionSupported || !preflight.outputDeviceFound || !preflight.accessibilityTrusted) {
    process.exitCode = 1;
  }
} finally {
  await adapter.close();
}

