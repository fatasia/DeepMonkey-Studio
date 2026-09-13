/// <reference types="@webgpu/types" />
import { BloomPass } from "@bim-studio/deep-engine/postprocess";
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";
import { DEFAULT_PBR_BLOOM_OPTIONS } from "../src/webgpu/pbrPostProcessChain.js";
import { decodeFloat16Bits, encodeFloat16Bits } from "./temporalAaProbe.js";

export type BloomProbePixel = readonly [number, number, number, number];
export interface BloomEnergyReadback {
  readonly size: number;
  readonly maxLevels: number;
  readonly levels: number;
  readonly passCount: number;
  readonly pixels: Float32Array<ArrayBuffer>;
}

/** Runs the production pass and releases its borrowed outputs only after readback completes. */
export async function readBloomEnergyCase(
  session: DeviceSession,
  size: number,
  maxLevels: number,
  pixelAt: (x: number, y: number) => BloomProbePixel,
): Promise<BloomEnergyReadback> {
  const device = session.device, owned: Array<GPUTexture | GPUBuffer> = [];
  const own = <T extends GPUTexture | GPUBuffer>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const rowBytes = Math.ceil(size * 8 / 256) * 256;
  let bloom: BloomPass | undefined, readback: GPUBuffer | undefined, scopes = 0;
  for (const filter of ["validation", "out-of-memory", "internal"] as const) { device.pushErrorScope(filter); scopes++; }
  try {
    bloom = new BloomPass(session);
    const color = own(device.createTexture({ label: "Deep bloom energy HDR input", size: [size, size], format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
    readback = own(device.createBuffer({ label: "Deep bloom energy readback", size: rowBytes * size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const bytes = new ArrayBuffer(rowBytes * size), upload = new DataView(bytes);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const pixel = pixelAt(x, y);
      for (let channel = 0; channel < 4; channel++) upload.setUint16(y * rowBytes + x * 8 + channel * 2, encodeFloat16Bits(pixel[channel]!), true);
    }
    device.queue.writeTexture({ texture: color }, bytes, { bytesPerRow: rowBytes, rowsPerImage: size }, [size, size]);
    const encoder = device.createCommandEncoder({ label: "Deep production bloom energy probe" });
    const result = bloom.encode(encoder, { color, revision: 0, colorEncoding: "linear-hdr" }, { ...DEFAULT_PBR_BLOOM_OPTIONS, maxLevels });
    encoder.copyTextureToBuffer({ texture: result.texture }, { buffer: readback, bytesPerRow: rowBytes, rowsPerImage: size }, [size, size]);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    const errors: string[] = [];
    while (scopes > 0) { scopes--; const error = await device.popErrorScope(); if (error) errors.push(error.message); }
    if (errors.length) throw new Error(errors.join("; "));
    await readback.mapAsync(GPUMapMode.READ);
    const source = new DataView(readback.getMappedRange()), pixels = new Float32Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) for (let channel = 0; channel < 4; channel++) {
      pixels[(y * size + x) * 4 + channel] = decodeFloat16Bits(source.getUint16(y * rowBytes + x * 8 + channel * 2, true));
    }
    return { size, maxLevels, levels: result.levels.length, passCount: result.passCount, pixels };
  } finally {
    if (readback?.mapState === "mapped") readback.unmap();
    while (scopes > 0) { scopes--; await device.popErrorScope().catch(() => null); }
    bloom?.dispose();
    for (const resource of owned.reverse()) session.release(resource);
  }
}
