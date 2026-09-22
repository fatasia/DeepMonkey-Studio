/// <reference types="@webgpu/types" />
import { volumetricFogPassCpu } from "../src/fog/volumetricFogPassCpu.js";
import { VolumetricFogPass } from "../src/fog/volumetricFogPass.js";
import type { VolumetricFogPassOptions } from "../src/fog/volumetricFogPassTypes.js";
import type { DeviceSession } from "../src/webgpu/deviceSession.js";

interface ProbeCase { readonly name: string; readonly width: number; readonly height: number; readonly depth: Float32Array }
interface Comparison { readonly maxAbsoluteError: number; readonly maxRelativeError: number; readonly failingValues: number }

const OPTIONS: VolumetricFogPassOptions = {
  verticalFovRadians: Math.PI / 3, steps: 48, maxDistance: 120,
  medium: { baseExtinction: 0.02, scaleHeight: 8, anisotropy: 0.3, albedo: 0.8 },
  light: { direction: [0.3, -0.8, 0.2], radiance: [1, 0.95, 0.9] },
};

function makeCases(): ProbeCase[] {
  const mixed = new Float32Array(13 * 7);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 13; x++) {
    mixed[y * 13 + x] = (x + y) % 5 === 0 ? 0 : 3 + x * 0.7 + y * 1.1;
  }
  return [
    { name: "mixed-npot-13x7", width: 13, height: 7, depth: mixed },
    { name: "geometry-even-8x8", width: 8, height: 8,
      depth: Float32Array.from({ length: 64 }, (_, index) => 2.5 + (index % 8) * 0.5 + Math.floor(index / 8) * 0.25) },
    { name: "sky-tiny-1x1", width: 1, height: 1, depth: new Float32Array([0]) },
  ];
}

function paddedRows(values: Float32Array, width: number, height: number): Uint8Array<ArrayBuffer> {
  const rowBytes = Math.ceil(width * 4 / 256) * 256, packed = new Uint8Array(new ArrayBuffer(rowBytes * height));
  const source = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  for (let row = 0; row < height; row++) packed.set(source.subarray(row * width * 4, (row + 1) * width * 4), row * rowBytes);
  return packed;
}

function halfToFloat(value: number): number {
  const sign = (value & 0x8000) ? -1 : 1, exponent = (value >>> 10) & 0x1f, fraction = value & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function decodeHalfRows(bytes: Uint8Array, width: number, height: number, rowBytes: number): Float32Array {
  const output = new Float32Array(width * height * 4), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++) {
    output[(y * width * 4) + x] = halfToFloat(view.getUint16(y * rowBytes + x * 2, true));
  }
  return output;
}

function compare(actual: Float32Array, expected: Float32Array): Comparison {
  let maxAbsoluteError = 0, maxRelativeError = 0, failingValues = 0;
  for (let index = 0; index < expected.length; index++) {
    const absolute = Math.abs((actual[index] ?? 0) - (expected[index] ?? 0));
    const relative = absolute / Math.max(Math.abs(expected[index] ?? 0), 1e-4);
    maxAbsoluteError = Math.max(maxAbsoluteError, absolute); maxRelativeError = Math.max(maxRelativeError, relative);
    // rgba16float quantization dominates low-magnitude scatter; use a combined absolute/relative gate.
    if (absolute > 8e-4 && relative > 0.012) failingValues++;
  }
  return { maxAbsoluteError, maxRelativeError, failingValues };
}

async function runCase(device: GPUDevice, probeCase: ProbeCase) {
  const owned = new Set<GPUTexture | GPUBuffer>();
  const session = { state: "ready", device, own<T extends GPUTexture | GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUTexture | GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } } as unknown as DeviceSession;
  const depth = device.createTexture({ label: `G7 ${probeCase.name} depth`, size: [probeCase.width, probeCase.height], format: "r32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  const uploadBytesPerRow = Math.ceil(probeCase.width * 4 / 256) * 256;
  device.queue.writeTexture({ texture: depth }, paddedRows(probeCase.depth, probeCase.width, probeCase.height),
    { bytesPerRow: uploadBytesPerRow, rowsPerImage: probeCase.height }, [probeCase.width, probeCase.height]);
  const pass = new VolumetricFogPass(session), repeats: Uint8Array[] = [];
  const copyModule = device.createShaderModule({ label: "G7 fog readback shader", code: `
    @group(0) @binding(0) var source: texture_2d<f32>;
    @vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
      let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
      return vec4f(positions[index], 0.0, 1.0);
    }
    @fragment fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
      return textureLoad(source, vec2i(position.xy), 0);
    }` });
  const copyPipeline = device.createRenderPipeline({ label: "G7 fog readback pipeline", layout: "auto",
    vertex: { module: copyModule, entryPoint: "vs" }, fragment: { module: copyModule, entryPoint: "fs", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list" } });
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      const encoder = device.createCommandEncoder({ label: `G7 ${probeCase.name} repeat ${repeat}` });
      const result = pass.encode(encoder, { depth, revision: repeat, depthEncoding: "linear-view-depth-positive" }, OPTIONS);
      const rowBytes = Math.ceil(result.width * 8 / 256) * 256;
      const copyTarget = device.createTexture({ label: "G7 fog copy target", size: [result.width, result.height], format: "rgba16float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      const bindGroup = device.createBindGroup({ layout: copyPipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: result.texture.createView() },
      ] });
      const copyPass = encoder.beginRenderPass({ colorAttachments: [{ view: copyTarget.createView(), loadOp: "clear", storeOp: "store",
        clearValue: [0, 0, 0, 0] }] });
      copyPass.setPipeline(copyPipeline); copyPass.setBindGroup(0, bindGroup); copyPass.draw(3); copyPass.end();
      const readback = device.createBuffer({ label: "G7 fog readback", size: rowBytes * result.height,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      encoder.copyTextureToBuffer({ texture: copyTarget }, { buffer: readback, bytesPerRow: rowBytes, rowsPerImage: result.height },
        [result.width, result.height]);
      device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
      repeats.push(new Uint8Array(readback.getMappedRange()).slice()); readback.unmap(); readback.destroy(); copyTarget.destroy();
    }
    const cpu = volumetricFogPassCpu({ width: probeCase.width, height: probeCase.height, depth: [...probeCase.depth] }, OPTIONS);
    const rowBytes = Math.ceil(cpu.width * 8 / 256) * 256, actual = decodeHalfRows(repeats[0]!, cpu.width, cpu.height, rowBytes);
    return { name: probeCase.name, sourceSize: [probeCase.width, probeCase.height], targetSize: [cpu.width, cpu.height],
      repeatStable: repeats[0]!.every((value, index) => value === repeats[1]![index]), comparison: compare(actual, cpu.scatter) };
  } finally {
    pass.dispose(); depth.destroy(); for (const resource of owned) resource.destroy();
  }
}

export async function runVolumetricFogGpuProbe() {
  const errors: string[] = [];
  try {
    if (!navigator.gpu) throw new Error("navigator.gpu unavailable");
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("requestAdapter returned null");
    const device = await adapter.requestDevice({ label: "G7 volumetric fog GPU probe" });
    const uncaptured: string[] = [];
    device.addEventListener("uncapturederror", event => uncaptured.push((event as GPUUncapturedErrorEvent).error.message));
    const cases = [];
    for (const probeCase of makeCases()) cases.push(await runCase(device, probeCase));
    await device.queue.onSubmittedWorkDone();
    const info = adapter.info;
    device.destroy();
    return { adapter: { vendor: info?.vendor ?? "", architecture: info?.architecture ?? "", device: info?.device ?? "",
      description: info?.description ?? "" }, cases, errors: [...errors, ...uncaptured] };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error)); return { cases: [], errors };
  }
}
