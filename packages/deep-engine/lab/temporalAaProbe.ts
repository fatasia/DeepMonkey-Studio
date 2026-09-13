/// <reference types="@webgpu/types" />
import { resolveTemporalAaCpu, TemporalAaPass, temporalAaJitter, type TemporalAaCpuInput,
  type TemporalAaResult, type TemporalAaSource } from "@bim-studio/deep-engine/postprocess";
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";

const WIDTH = 4, HEIGHT = 1, ROW_BYTES = 256;
const OPTIONS = { feedback: 0.9, depthThreshold: 0.1, relativeDepthThreshold: 0.02 } as const;
const DEPTH = Object.freeze(Array(WIDTH * HEIGHT).fill(4) as number[]);

export interface TemporalAaProbeResult {
  readonly action: "temporal-aa-hdr-history";
  readonly success: boolean;
  readonly firstFrameNoGhost: boolean;
  readonly staticConvergence: boolean;
  readonly motionReprojection: boolean;
  readonly cameraCutNoGhost: boolean;
  readonly cpuGpuAgreement: boolean;
  readonly pingPong: boolean;
  readonly maxAbsoluteError: number;
  readonly staticPixel: readonly number[];
  readonly motionPixel: readonly number[];
  readonly cameraCutPixel: readonly number[];
}

interface Frame { readonly result: TemporalAaResult; readonly output: readonly number[] }

export function encodeFloat16Bits(value: number): number {
  if (Number.isNaN(value)) return 0x7e00;
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0, magnitude = Math.abs(value);
  if (magnitude === Infinity) return sign | 0x7c00;
  if (magnitude < 2 ** -24) return sign;
  if (magnitude < 2 ** -14) return sign | Math.min(0x3ff, Math.round(magnitude / 2 ** -24));
  let exponent = Math.floor(Math.log2(magnitude)), fraction = Math.round((magnitude / 2 ** exponent - 1) * 1024);
  if (fraction === 1024) { exponent += 1; fraction = 0; }
  if (exponent > 15) return sign | 0x7c00;
  return sign | ((exponent + 15) << 10) | fraction;
}

export function decodeFloat16Bits(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1, exponent = (bits >>> 10) & 0x1f, fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * fraction / 1024;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function halfTextureBytes(values: readonly number[], channels: number): Uint8Array {
  const bytes = new Uint8Array(ROW_BYTES * HEIGHT), view = new DataView(bytes.buffer);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) for (let channel = 0; channel < channels; channel++)
    view.setUint16(pixel * channels * 2 + channel * 2, encodeFloat16Bits(values[pixel * channels + channel]!), true);
  return bytes;
}

function depthTextureBytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(ROW_BYTES * HEIGHT), view = new DataView(bytes.buffer);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) view.setFloat32(pixel * 4, values[pixel]!, true);
  return bytes;
}

function decodedHalf(values: readonly number[]): number[] { return values.map(value => decodeFloat16Bits(encodeFloat16Bits(value))); }
function maximumError(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  let result = 0;
  for (let index = 0; index < actual.length; index++) result = Math.max(result, Math.abs(actual[index]! - expected[index]!));
  return result;
}
function pixel(values: readonly number[], index: number): readonly number[] { return Object.freeze(values.slice(index * 4, index * 4 + 4)); }

/** Standalone real WebGPU TAA resolve/readback probe; intentionally not connected to Lab main. */
export async function verifyTemporalAa(session: DeviceSession): Promise<TemporalAaProbeResult> {
  if (session.state !== "ready") throw new Error("Temporal AA probe requires a ready device session.");
  const device = session.device, pass = new TemporalAaPass(session), owned: Array<GPUTexture | GPUBuffer> = [];
  const own = <T extends GPUTexture | GPUBuffer>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const inputTexture = (label: string, format: GPUTextureFormat) => own(device.createTexture({ label, size: [WIDTH, HEIGHT], format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST }));
  const color = inputTexture("Deep TAA probe HDR color", "rgba16float"), depth = inputTexture("Deep TAA probe linear depth", "r32float");
  const motion = inputTexture("Deep TAA probe motion", "rg16float");
  const readback = own(device.createBuffer({ label: "Deep TAA probe readback", size: ROW_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const source = (revision: number, cameraCut = false): TemporalAaSource => ({ color, depth, motion, revision, cameraCut,
    colorEncoding: "linear-hdr", depthEncoding: "linear-view-depth-positive", motionEncoding: "current-to-previous-uv" });
  const run = async (colors: readonly number[], motions: readonly number[], revision: number, cameraCut = false): Promise<Frame> => {
    device.queue.writeTexture({ texture: color }, halfTextureBytes(colors, 4).buffer as ArrayBuffer,
      { bytesPerRow: ROW_BYTES, rowsPerImage: HEIGHT }, [WIDTH, HEIGHT]);
    device.queue.writeTexture({ texture: depth }, depthTextureBytes(DEPTH).buffer as ArrayBuffer,
      { bytesPerRow: ROW_BYTES, rowsPerImage: HEIGHT }, [WIDTH, HEIGHT]);
    device.queue.writeTexture({ texture: motion }, halfTextureBytes(motions, 2).buffer as ArrayBuffer,
      { bytesPerRow: ROW_BYTES, rowsPerImage: HEIGHT }, [WIDTH, HEIGHT]);
    const encoder = device.createCommandEncoder({ label: "Deep TAA probe command" }), result = pass.encode(encoder, source(revision, cameraCut), OPTIONS);
    encoder.copyTextureToBuffer({ texture: result.texture }, { buffer: readback, bytesPerRow: ROW_BYTES, rowsPerImage: HEIGHT }, [WIDTH, HEIGHT]);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
    const view = new DataView(readback.getMappedRange()), output: number[] = [];
    for (let x = 0; x < WIDTH; x++) for (let channel = 0; channel < 4; channel++)
      output.push(decodeFloat16Bits(view.getUint16(x * 8 + channel * 2, true)));
    readback.unmap(); return { result, output: Object.freeze(output) };
  };
  const cpu = (colors: readonly number[], motions: readonly number[], revision: number, historyValid: boolean,
    previousColor?: readonly number[], previousRevision = revision): Float32Array => {
    const input: TemporalAaCpuInput = { width: WIDTH, height: HEIGHT, color: decodedHalf(colors), depth: DEPTH,
      motion: decodedHalf(motions), currentJitter: temporalAaJitter(revision), previousJitter: temporalAaJitter(previousRevision), historyValid,
      ...(previousColor ? { previousColor: decodedHalf(previousColor) } : {}), ...(historyValid ? { previousDepth: DEPTH } : {}) };
    return resolveTemporalAaCpu(input, OPTIONS);
  };
  try {
    const zeroMotion = Array(WIDTH * 2).fill(0), staticColor = Array.from({ length: WIDTH }, () => [0.125, 0.25, 0.5, 1]).flat();
    const first = await run(staticColor, zeroMotion, 0), second = await run(staticColor, zeroMotion, 1);
    const historyColor = [[1, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1], [0, 0, 0, 1]].flat();
    const seeded = await run(historyColor, zeroMotion, 2, true);
    const currentColor = [[0, 0, 0, 1], [0.25, 0, 0, 1], [1, 0, 0, 1], [0, 0, 0, 1]].flat();
    const previousJitter = temporalAaJitter(2), currentJitter = temporalAaJitter(3), motionValues = Array(WIDTH * 2).fill(0);
    motionValues[2] = (-1 - (previousJitter[0] - currentJitter[0])) / WIDTH;
    motionValues[3] = -(previousJitter[1] - currentJitter[1]);
    const moved = await run(currentColor, motionValues, 3);
    const cutColor = Array.from({ length: WIDTH }, () => [0, 1, 0, 1]).flat(), cut = await run(cutColor, zeroMotion, 4, true);
    const expected = [cpu(staticColor, zeroMotion, 0, false), cpu(staticColor, zeroMotion, 1, true, staticColor, 0),
      cpu(historyColor, zeroMotion, 2, false), cpu(currentColor, motionValues, 3, true, historyColor, 2), cpu(cutColor, zeroMotion, 4, false)];
    const frames = [first, second, seeded, moved, cut], maxAbsoluteError = Math.max(...frames.map((frame, index) => maximumError(frame.output, expected[index]!)));
    const firstFrameNoGhost = !first.result.historyUsed && first.result.historyInvalidation === "first-frame" && maximumError(first.output, expected[0]!) <= 0.001;
    const staticConvergence = second.result.historyUsed && maximumError(second.output, staticColor) <= 0.001;
    const motionPixel = pixel(moved.output, 1), cameraCutPixel = pixel(cut.output, 1), staticPixel = pixel(second.output, 1);
    const motionReprojection = moved.result.historyUsed && motionPixel[0]! > 0.9 && motionPixel[1]! < 0.002 && motionPixel[2]! < 0.002;
    const cameraCutNoGhost = !cut.result.historyUsed && cut.result.historyInvalidation === "camera-cut"
      && cameraCutPixel[0]! < 0.002 && Math.abs(cameraCutPixel[1]! - 1) < 0.002 && cameraCutPixel[2]! < 0.002;
    const cpuGpuAgreement = maxAbsoluteError <= 0.002, pingPong = first.result.texture !== second.result.texture && seeded.result.texture !== moved.result.texture;
    return Object.freeze({ action: "temporal-aa-hdr-history", success: firstFrameNoGhost && staticConvergence && motionReprojection
      && cameraCutNoGhost && cpuGpuAgreement && pingPong, firstFrameNoGhost, staticConvergence, motionReprojection, cameraCutNoGhost,
      cpuGpuAgreement, pingPong, maxAbsoluteError, staticPixel, motionPixel, cameraCutPixel });
  } finally { pass.dispose(); for (const resource of owned) session.release(resource); }
}
