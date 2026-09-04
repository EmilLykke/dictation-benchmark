import { readFileSync } from "node:fs";

export function wavDurationSec(path: string): number {
  const bytes = readFileSync(path);
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a RIFF/WAVE file: ${path}`);
  }

  let offset = 12;
  let byteRate: number | null = null;
  let dataBytes: number | null = null;

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) break;

    if (id === "fmt " && size >= 16) byteRate = bytes.readUInt32LE(start + 8);
    if (id === "data") dataBytes = size;
    if (byteRate !== null && dataBytes !== null) break;

    offset = start + size + (size % 2);
  }

  if (!byteRate || dataBytes === null) {
    throw new Error(`WAV missing fmt or data chunk: ${path}`);
  }
  return dataBytes / byteRate;
}

