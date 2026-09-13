/// <reference types="@webgpu/types" />
import { evaluateForwardPlusPbrCpu, FORWARD_PLUS_PBR_WGSL, ForwardPlusClusterAssigner,
  ForwardPlusPbrLightingBindings, type ClusteredLights, type ForwardPlusPbrSurface } from "@bim-studio/deep-engine/lighting";
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";

const GRID = { viewportWidth: 1, viewportHeight: 1, tileSizeX: 1, tileSizeY: 1,
  zSlices: 4, near: 1, far: 16, verticalFovRadians: Math.PI / 2, maxLightsPerCluster: 8 } as const;
const ROW_BYTES = 256;
const PROBE_WGSL = /* wgsl */ `${FORWARD_PLUS_PBR_WGSL}
struct ProbeSurface {
  positionView: vec4f,
  normalMetallic: vec4f,
  baseRoughness: vec4f,
};
@group(0) @binding(0) var<uniform> probeSurface: ProbeSurface;
@vertex fn probeVertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}
@fragment fn probeFragment(@builtin(position) fragment: vec4f) -> @location(0) vec4f {
  return vec4f(deepForwardPlusPbr(fragment.xy, probeSurface.positionView.xyz, probeSurface.normalMetallic.xyz,
    probeSurface.baseRoughness.xyz, probeSurface.normalMetallic.w, probeSurface.baseRoughness.w), 1.0);
}`;

export interface ForwardPlusPbrProbeResult {
  readonly action: "forward-plus-pbr-lighting";
  readonly success: boolean;
  readonly cpuGpuAgreement: boolean;
  readonly leftRightPoint: boolean;
  readonly spotCone: boolean;
  readonly rangeCutoff: boolean;
  readonly additive: boolean;
  readonly noLightFinite: boolean;
  readonly stableBindings: boolean;
  readonly maxRelativeError: number;
}

interface SampleResult { readonly gpu: readonly number[]; readonly cpu: readonly number[]; readonly relativeError: number; readonly bindGroup: GPUBindGroup }
const point = (positionView: readonly [number, number, number], color: readonly [number, number, number], range: number) =>
  ({ positionView, color, range, intensity: 2 });
const surface = (positionView: readonly [number, number, number]): ForwardPlusPbrSurface => ({
  fragmentCoordinate: [0.5, 0.5], positionView, normalView: [0, 0, 1], baseColor: [0.8, 0.7, 0.6], metallic: 0.2, roughness: 0.45,
});

function decodeFloat16(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1, exponent = (bits >>> 10) & 0x1f, fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * fraction / 1024;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function packSurface(value: ForwardPlusPbrSurface): ArrayBuffer {
  return new Float32Array([...value.positionView, 0, ...value.normalView, value.metallic, ...value.baseColor, value.roughness]).buffer;
}

function relativeError(actual: readonly number[], expected: readonly number[]): number {
  return Math.max(...actual.map((value, index) => Math.abs(value - expected[index]!) / Math.max(0.02, Math.abs(expected[index]!))));
}

/** Real render/readback validation, kept independent from Lab main until the renderer selects the optional variant. */
export async function verifyForwardPlusPbrLighting(session: DeviceSession): Promise<ForwardPlusPbrProbeResult> {
  if (session.state !== "ready") throw new Error("Forward+ PBR probe requires a ready device session.");
  const device = session.device, assigner = new ForwardPlusClusterAssigner(session), lighting = new ForwardPlusPbrLightingBindings(session);
  const owned: Array<GPUBuffer | GPUTexture> = [], own = <T extends GPUBuffer | GPUTexture>(resource: T): T => { owned.push(session.own(resource)); return resource; };
  const surfaceLayout = device.createBindGroupLayout({ label: "Deep Forward+ PBR probe surface layout", entries: [{ binding: 0,
    visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }] });
  const empty1 = device.createBindGroupLayout({ label: "Deep Forward+ PBR probe empty group 1", entries: [] });
  const empty2 = device.createBindGroupLayout({ label: "Deep Forward+ PBR probe empty group 2", entries: [] });
  const module = device.createShaderModule({ label: "Deep Forward+ PBR probe WGSL", code: PROBE_WGSL });
  const pipeline = device.createRenderPipeline({ label: "Deep Forward+ PBR probe pipeline",
    layout: device.createPipelineLayout({ bindGroupLayouts: [surfaceLayout, empty1, empty2, lighting.layout] }),
    vertex: { module, entryPoint: "probeVertex" }, fragment: { module, entryPoint: "probeFragment", targets: [{ format: "rgba16float" }] },
    primitive: { topology: "triangle-list", cullMode: "none" } });
  const surfaceBuffer = own(device.createBuffer({ label: "Deep Forward+ PBR probe surface", size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
  const surfaceGroup = device.createBindGroup({ label: "Deep Forward+ PBR probe surface binding", layout: surfaceLayout,
    entries: [{ binding: 0, resource: { buffer: surfaceBuffer } }] });
  const target = own(device.createTexture({ label: "Deep Forward+ PBR probe target", size: [1, 1], format: "rgba16float",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }));
  const readback = own(device.createBuffer({ label: "Deep Forward+ PBR probe readback", size: ROW_BYTES,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const run = async (lights: ClusteredLights, sample: ForwardPlusPbrSurface): Promise<SampleResult> => {
    const resources = assigner.prepare(GRID, lights, { cpuReference: true }), binding = lighting.bind(resources);
    device.queue.writeBuffer(surfaceBuffer, 0, packSurface(sample));
    const encoder = device.createCommandEncoder({ label: "Deep Forward+ PBR probe command" }); assigner.encode(encoder);
    const pass = encoder.beginRenderPass({ label: "Deep Forward+ PBR probe draw", colorAttachments: [{ view: target.createView(),
      clearValue: [0, 0, 0, 1], loadOp: "clear", storeOp: "store" }] });
    pass.setPipeline(pipeline); pass.setBindGroup(0, surfaceGroup); pass.setBindGroup(3, binding.bindGroup); pass.draw(3); pass.end();
    encoder.copyTextureToBuffer({ texture: target }, { buffer: readback, bytesPerRow: ROW_BYTES, rowsPerImage: 1 }, [1, 1]);
    device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
    const raw = new Uint16Array(readback.getMappedRange().slice(0, 8)), gpu = Array.from(raw.slice(0, 3), decodeFloat16); readback.unmap();
    const cpu = evaluateForwardPlusPbrCpu(resources.cpuReference!, lights, sample).color;
    return { gpu, cpu, relativeError: relativeError(gpu, cpu), bindGroup: binding.bindGroup };
  };
  try {
    const coloredPoints = { points: [point([-1, 0, -2], [1, 0, 0], 2.2), point([1, 0, -2], [0, 1, 0], 2.2)] };
    const left = await run(coloredPoints, surface([-1, 0, -4])), right = await run(coloredPoints, surface([1, 0, -4]));
    const spot = { spots: [{ ...point([0, 0, -2], [1, 0.5, 0.25], 5), directionView: [0, 0, -1] as const,
      outerConeCos: Math.cos(Math.PI / 6), innerConeCos: Math.cos(Math.PI / 12) }] };
    const spotInside = await run(spot, surface([0, 0, -4])), spotOutside = await run(spot, surface([2, 0, -4]));
    const inRangeLights = { points: [point([0, 0, -2], [1, 1, 1], 3)] }, outOfRangeLights = { points: [point([0, 0, -2], [1, 1, 1], 1)] };
    const inRange = await run(inRangeLights, surface([0, 0, -4])), outOfRange = await run(outOfRangeLights, surface([0, 0, -4]));
    const single = await run(inRangeLights, surface([0, 0, -4]));
    const doubled = await run({ points: [...inRangeLights.points, ...inRangeLights.points] }, surface([0, 0, -4]));
    const unlit = await run({}, surface([0, 0, -4]));
    const samples = [left, right, spotInside, spotOutside, inRange, outOfRange, single, doubled, unlit];
    const maxRelativeError = Math.max(...samples.map(sample => sample.relativeError));
    const cpuGpuAgreement = maxRelativeError <= 0.035;
    const leftRightPoint = left.gpu[0]! > left.gpu[1]! * 10 && right.gpu[1]! > right.gpu[0]! * 10;
    const spotCone = spotInside.gpu[0]! > 0.02 && spotOutside.gpu.every(value => Math.abs(value) < 0.005);
    const rangeCutoff = inRange.gpu[0]! > 0.02 && outOfRange.gpu.every(value => Math.abs(value) < 0.005);
    const additive = doubled.gpu.every((value, index) => Math.abs(value - single.gpu[index]! * 2) <= Math.max(0.01, value * 0.03));
    const noLightFinite = unlit.gpu.every(value => Number.isFinite(value) && Math.abs(value) < 0.005);
    const stableBindings = left.bindGroup === right.bindGroup;
    return { action: "forward-plus-pbr-lighting", success: cpuGpuAgreement && leftRightPoint && spotCone && rangeCutoff && additive
      && noLightFinite && stableBindings, cpuGpuAgreement, leftRightPoint, spotCone, rangeCutoff, additive, noLightFinite, stableBindings, maxRelativeError };
  } finally {
    lighting.dispose(); assigner.dispose(); for (const resource of owned) session.release(resource);
  }
}
