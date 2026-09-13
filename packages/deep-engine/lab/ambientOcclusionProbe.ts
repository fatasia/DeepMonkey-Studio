/// <reference types="@webgpu/types" />
import { AmbientOcclusionPass, computeAmbientOcclusionCpu, type AmbientOcclusionCpuInput,
  type AmbientOcclusionOptions, type AmbientOcclusionSource } from "@bim-studio/deep-engine/postprocess";
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";

const SOURCE_WIDTH = 8, SOURCE_HEIGHT = 8, OUTPUT_WIDTH = 4, OUTPUT_HEIGHT = 4, ROW_BYTES = 256;
const OPTIONS: AmbientOcclusionOptions = { verticalFovRadians: Math.PI / 2, radius: 3, thickness: 0.05, power: 1.5 };

export interface AmbientOcclusionProbeResult {
  readonly action: "half-resolution-gtao-ssao";
  readonly success: boolean;
  readonly flatPlaneUnoccluded: boolean;
  readonly cavityDetected: boolean;
  readonly cpuGpuAgreement: boolean;
  readonly stableReuse: boolean;
  readonly cachedRevision: boolean;
  readonly outputSize: readonly [number, number];
  readonly flatRange: readonly [number, number];
  readonly cavityRange: readonly [number, number];
  readonly maxAbsoluteError: number;
}

function range(values: readonly number[]): readonly [number, number] { return [Math.min(...values), Math.max(...values)]; }
function normals(): number[] { return Array.from({ length: SOURCE_WIDTH * SOURCE_HEIGHT }, () => [0, 0, 1]).flat(); }
function paddedDepth(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(ROW_BYTES * SOURCE_HEIGHT), view = new DataView(bytes.buffer);
  for (let y = 0; y < SOURCE_HEIGHT; y++) for (let x = 0; x < SOURCE_WIDTH; x++) view.setFloat32(y * ROW_BYTES + x * 4, values[y * SOURCE_WIDTH + x]!, true);
  return bytes;
}
function paddedNormals(): Uint8Array {
  const bytes = new Uint8Array(ROW_BYTES * SOURCE_HEIGHT);
  for (let y = 0; y < SOURCE_HEIGHT; y++) for (let x = 0; x < SOURCE_WIDTH; x++) {
    const offset = y * ROW_BYTES + x * 4; bytes[offset] = 128; bytes[offset + 1] = 128; bytes[offset + 2] = 255; bytes[offset + 3] = 255;
  }
  return bytes;
}
function maxError(actual: readonly number[], expected: readonly number[]): number {
  return Math.max(...actual.map((value, index) => Math.abs(value - expected[index]!)));
}

/** Standalone real-device AO compute/readback probe; intentionally not imported by Lab main. */
export async function verifyAmbientOcclusion(session: DeviceSession): Promise<AmbientOcclusionProbeResult> {
  if (session.state !== "ready") throw new Error("Ambient occlusion probe requires a ready device session.");
  const device = session.device, pass = new AmbientOcclusionPass(session), owned: Array<GPUTexture | GPUBuffer> = [];
  const own = <T extends GPUTexture | GPUBuffer>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const depth = own(device.createTexture({ label: "Deep AO probe linear depth", size: [SOURCE_WIDTH, SOURCE_HEIGHT], format: "r32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
  const normal = own(device.createTexture({ label: "Deep AO probe view normals", size: [SOURCE_WIDTH, SOURCE_HEIGHT], format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
  const readback = own(device.createBuffer({ label: "Deep AO probe readback", size: ROW_BYTES * OUTPUT_HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  device.queue.writeTexture({ texture: normal }, paddedNormals().buffer as ArrayBuffer, { bytesPerRow: ROW_BYTES, rowsPerImage: SOURCE_HEIGHT }, [SOURCE_WIDTH, SOURCE_HEIGHT]);
  const source = (revision: number): AmbientOcclusionSource => ({ depth, normal, revision,
    depthEncoding: "linear-view-depth-positive", normalSpace: "view" });
  const run = async (values: readonly number[], revision: number) => {
    device.queue.writeTexture({ texture: depth }, paddedDepth(values).buffer as ArrayBuffer, { bytesPerRow: ROW_BYTES, rowsPerImage: SOURCE_HEIGHT }, [SOURCE_WIDTH, SOURCE_HEIGHT]);
    const encoder = device.createCommandEncoder({ label: "Deep AO probe command" }), result = pass.encode(encoder, source(revision), OPTIONS);
    encoder.copyTextureToBuffer({ texture: result.texture }, { buffer: readback, bytesPerRow: ROW_BYTES, rowsPerImage: OUTPUT_HEIGHT }, [OUTPUT_WIDTH, OUTPUT_HEIGHT]);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
    const raw = new Float32Array(readback.getMappedRange().slice(0)), output: number[] = [];
    for (let y = 0; y < OUTPUT_HEIGHT; y++) for (let x = 0; x < OUTPUT_WIDTH; x++) output.push(raw[y * ROW_BYTES / 4 + x]!);
    readback.unmap(); return { result, output };
  };
  try {
    const flatDepth = Array(SOURCE_WIDTH * SOURCE_HEIGHT).fill(4), cavityDepth = Array(SOURCE_WIDTH * SOURCE_HEIGHT).fill(3);
    cavityDepth[3 * SOURCE_WIDTH + 3] = 4; cavityDepth[3 * SOURCE_WIDTH + 5] = 4;
    const flat = await run(flatDepth, 0), cavity = await run(cavityDepth, 1);
    const cached = pass.encode(device.createCommandEncoder({ label: "Deep AO cached revision probe" }), source(1), OPTIONS);
    const flatCpuInput: AmbientOcclusionCpuInput = { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, depth: flatDepth, normals: normals() };
    const cavityCpuInput: AmbientOcclusionCpuInput = { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, depth: cavityDepth, normals: normals() };
    const flatCpu = Array.from(computeAmbientOcclusionCpu(flatCpuInput, OPTIONS).output);
    const cavityCpu = Array.from(computeAmbientOcclusionCpu(cavityCpuInput, OPTIONS).output);
    const error = Math.max(maxError(flat.output, flatCpu), maxError(cavity.output, cavityCpu));
    const flatRange = range(flat.output), cavityRange = range(cavity.output);
    const flatPlaneUnoccluded = flat.output.every(value => Number.isFinite(value) && Math.abs(value - 1) <= 0.005);
    const cavityDetected = cavityRange[0] < 0.8 && cavityRange[1] > 0.95;
    const cpuGpuAgreement = error <= 0.035;
    const stableReuse = flat.result.texture === cavity.result.texture;
    const cachedRevision = !cached.updated && cached.texture === cavity.result.texture;
    return { action: "half-resolution-gtao-ssao", success: flatPlaneUnoccluded && cavityDetected && cpuGpuAgreement && stableReuse && cachedRevision,
      flatPlaneUnoccluded, cavityDetected, cpuGpuAgreement, stableReuse, cachedRevision,
      outputSize: [cavity.result.width, cavity.result.height], flatRange, cavityRange, maxAbsoluteError: error };
  } finally { pass.dispose(); for (const resource of owned.reverse()) session.release(resource); }
}
