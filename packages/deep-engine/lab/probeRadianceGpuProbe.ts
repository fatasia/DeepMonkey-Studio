/**
 * Deep GI 探针一跳场景辐射真机证据探针（F1 第一切片）：headless Chrome + 真 WebGPU，
 * 走完整生产链（ProbeSceneRadianceProducer.syncScene → syncLighting → encodeSourceRadiance
 * → 捕获纹理 → copyTextureToBuffer 读回 rgba16float），与同 bundle 的 CPU 参考
 * （buildRenderPacketRayScene + traceTlasClosest + probeOcclusionDirection + 同一着色公式）
 * 逐探针对拍。场景：y=0 地面（albedo 0.6/0.55/0.5）+ 悬空盒遮挡体（albedo 0.2/0.8/0.4，
 * identity 变换、世界坐标直接建模），三个探针：遮挡下方 / 开阔天空 / 遮挡体上方。
 * 模式完全沿用 rayTraceGpuTest.mjs（esbuild bundle + playwright headless）。
 */

import type { RenderPacket } from "../src/renderPacket.js";
import type { ProbeUpdate } from "../src/lighting/probeClipmapPlan.js";
import type { ProbeCaptureBeginContext } from "../src/lighting/probeClipmapCaptureExecutor.js";
import { buildRenderPacketRayScene } from "../src/rayTracing/renderPacketRayScene.js";
import { probeOcclusionDirection } from "../src/rayTracing/probeOcclusionRayExtension.js";
import { traceTlasClosest } from "../src/rayTracing/tlas.js";
import { RENDER_PACKET_GI_RAY_MASK } from "../src/rayTracing/renderPacketRayScene.js";
import { ProbeSceneRadianceProducer } from "../src/rayTracing/probeSceneRadianceProducer.js";
import { emitProbeRadianceKernelWgsl } from "../src/rayTracing/probeRadianceKernel.js";

export { emitProbeRadianceKernelWgsl };

export interface ProbeRadianceGpuResult {
  readonly probes: readonly {
    readonly name: string;
    readonly position: readonly [number, number, number];
    readonly gpu: readonly [number, number, number];
    readonly cpu: readonly [number, number, number];
  }[];
  readonly rawHalfWords: readonly number[];
  readonly overflowSentinel: number;
  readonly validationMessages: readonly string[];
  readonly openSkyExceedsOccluded: boolean;
  readonly oneBounceEnergyPresent: boolean;
  readonly adapter: string;
}

const DIRECTION_COUNT = 8, T_MAX = 32;
const SUN = { surfaceToLightWorld: [0, 1, 0], color: [1, 1, 1], intensity: 3 } as const;
const AMBIENT = [0.05, 0.05, 0.06] as const;
const GROUND_ALBEDO = [0.6, 0.55, 0.5] as const, BOX_ALBEDO = [0.2, 0.8, 0.4] as const;

const PROBES: readonly { name: string; position: readonly [number, number, number] }[] = [
  // Offsets deliberately avoid exact box tangency: a grazing Fibonacci direction flips
  // hit/miss between f64 CPU and f32 GPU rounding, which is a fixture degeneracy, not a
  // kernel defect (kernel semantics are the mirrored two-level traversal).
  { name: "occluded-below-box", position: [0.37, 0.5, 0.21] },
  { name: "open-sky", position: [3, 0.5, 0] },
  { name: "above-box", position: [0, 3.5, 0] },
];

function radianceCasePacket(): RenderPacket {
  const size = 10;
  const ground = new Float32Array([
    -size, 0, -size, 0, 1, 0, size, 0, -size, 0, 1, 0, size, 0, size, 0, 1, 0,
    -size, 0, -size, 0, 1, 0, size, 0, size, 0, 1, 0, -size, 0, size, 0, 1, 0]);
  const h = 0.5, lo = -h, hi = h; // box centered at [0, 1.5, 0], world-space vertices, identity transform
  const cy = 1.5;
  const v = (x: number, y: number, z: number): number[] => [x, cy + y, z];
  const boxFaces: number[][] = [
    [[lo, hi, lo], [lo, hi, hi], [hi, hi, hi], [lo, hi, lo], [hi, hi, hi], [hi, hi, lo]], // top +y
    [[lo, lo, lo], [hi, lo, lo], [hi, lo, hi], [lo, lo, lo], [hi, lo, hi], [lo, lo, hi]], // bottom -y
    [[lo, lo, hi], [hi, lo, hi], [hi, hi, hi], [lo, lo, hi], [hi, hi, hi], [lo, hi, hi]], // +z
    [[hi, lo, lo], [lo, lo, lo], [lo, hi, lo], [hi, lo, lo], [lo, hi, lo], [hi, hi, lo]], // -z
    [[hi, lo, hi], [hi, lo, lo], [hi, hi, lo], [hi, lo, hi], [hi, hi, lo], [hi, hi, hi]], // +x
    [[lo, lo, lo], [lo, lo, hi], [lo, hi, hi], [lo, lo, lo], [lo, hi, hi], [lo, hi, lo]], // -x
  ];
  const normals: number[][] = [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]];
  const boxVertices: number[] = [];
  boxFaces.forEach((face, index) => face.forEach(vertex => boxVertices.push(...v(vertex[0] as number,
    vertex[1] as number, vertex[2] as number), ...normals[index]!)));
  return {
    geometries: [
      { id: "ground", revision: 0, vertices: ground, indices: new Uint32Array([0, 1, 2, 3, 4, 5]) },
      { id: "box", revision: 0, vertices: new Float32Array(boxVertices),
        indices: new Uint32Array(Array.from({ length: 36 }, (_, index) => index)) },
    ],
    materials: [
      { id: "ground-m", baseColor: GROUND_ALBEDO, metallic: 0, roughness: 1 },
      { id: "box-m", baseColor: BOX_ALBEDO, metallic: 0, roughness: 1 },
    ],
    instances: [
      { id: "ground-1", geometry: "ground", material: "ground-m",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { id: "box-1", geometry: "box", material: "box-m",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ],
  };
}

/** CPU 参考：与 probeRadianceKernel 同公式（Fibonacci 方向、双面法线、Lambert/π、环境 miss）。 */
export function cpuReferenceFor(packet: RenderPacket, position: readonly [number, number, number],
  albedos: readonly (readonly [number, number, number])[]): {
    readonly mean: readonly [number, number, number];
    readonly contributions: readonly (readonly [number, number, number])[];
  } {
  const scene = buildRenderPacketRayScene(packet);
  const instanceAlbedo = new Map(scene.materials.map((binding, index) => [binding.instanceId, albedos[index]!]));
  let sum: [number, number, number] = [0, 0, 0];
  const contributions: [number, number, number][] = [];
  for (let ordinal = 0; ordinal < DIRECTION_COUNT; ordinal++) {
    const [dx, dy, dz] = probeOcclusionDirection(ordinal, DIRECTION_COUNT);
    const hit = traceTlasClosest(scene.tlas, { ox: position[0], oy: position[1], oz: position[2],
      dx, dy, dz, tMax: T_MAX }, RENDER_PACKET_GI_RAY_MASK);
    let contribution: [number, number, number];
    if (!hit) {
      contribution = [AMBIENT[0], AMBIENT[1], AMBIENT[2]];
    } else {
      const packetInstance = packet.instances.find(candidate => candidate.id === hit.instanceId)!;
      const albedo = instanceAlbedo.get(hit.instanceId)!;
      const geometry = packet.geometries.find(candidate => candidate.id === packetInstance.geometry)!;
      const i0 = geometry.indices[hit.primitiveIndex * 3]! * 6;
      const i1 = geometry.indices[hit.primitiveIndex * 3 + 1]! * 6;
      const i2 = geometry.indices[hit.primitiveIndex * 3 + 2]! * 6;
      const ax = geometry.vertices[i0]!, ay = geometry.vertices[i0 + 1]!, az = geometry.vertices[i0 + 2]!;
      const bx = geometry.vertices[i1]!, by = geometry.vertices[i1 + 1]!, bz = geometry.vertices[i1 + 2]!;
      const cx = geometry.vertices[i2]!, cy2 = geometry.vertices[i2 + 1]!, cz = geometry.vertices[i2 + 2]!;
      const e1 = [bx - ax, by - ay, bz - az], e2 = [cx - ax, cy2 - ay, cz - az];
      let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
      let ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
      let nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
      const normalLength = Math.hypot(nx, ny, nz); nx /= normalLength; ny /= normalLength; nz /= normalLength;
      if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
      const nDotL = Math.max(nx * SUN.surfaceToLightWorld[0] + ny * SUN.surfaceToLightWorld[1]
        + nz * SUN.surfaceToLightWorld[2], 0);
      contribution = albedo.map((channel, axis) =>
        channel * SUN.color[axis]! * SUN.intensity * nDotL / Math.PI) as [number, number, number];
    }
    contributions.push(contribution);
    sum = [sum[0] + contribution[0], sum[1] + contribution[1], sum[2] + contribution[2]];
  }
  return { mean: [sum[0] / DIRECTION_COUNT, sum[1] / DIRECTION_COUNT, sum[2] / DIRECTION_COUNT],
    contributions };
}

function decodeHalf(value: number): number {
  const exponent = (value & 0x7c00) >> 10, fraction = value & 0x03ff;
  if (exponent === 0) return (value & 0x8000 ? -1 : 1) * fraction * 2 ** -24;
  if (exponent === 0x1f) return (value & 0x8000 ? -1 : 1) * (fraction ? Number.NaN : Number.POSITIVE_INFINITY);
  return (value & 0x8000 ? -1 : 1) * ((exponent - 15) > 0
    ? (1 + fraction / 1024) * 2 ** (exponent - 15) : (1 + fraction / 1024) * 2 ** (exponent - 15));
}

function probeUpdates(): ProbeUpdate[] {
  // One probe per layer (localCell.z = index), texel (0,0) in each layer: mirrors the
  // production capture layout (layer = localCell.z + level * gridSize.z) without needing
  // in-plane cells wider than one texel.
  return PROBES.map((probe, index) => Object.freeze({ level: 0, cell: [0, 0, index],
    localCell: [0, 0, index], linearIndex: index, position: Object.freeze([...probe.position]),
    reason: "initial" } as unknown as ProbeUpdate));
}

export async function runProbeRadianceGpuProbe(): Promise<ProbeRadianceGpuResult> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const device = await adapter.requestDevice({ label: "probe-radiance-gpu-probe" });
  try {
    const errors: string[] = [];
    device.addEventListener?.("uncapturederror", event => {
      errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
    });
    // Kernel compilation diagnostics: the producer builds its own module internally, so
    // compile the same WGSL once more purely for getCompilationInfo evidence.
    const diagnostic = device.createShaderModule({ label: "probe-radiance-diagnostic",
      code: emitProbeRadianceKernelWgsl() });
    const validationMessages = (await diagnostic.getCompilationInfo()).messages
      .filter(message => message.type !== "info")
      .map(message => `${message.type}:${message.lineNum}:${message.message}`);

    const packet = radianceCasePacket();
    const producer = new ProbeSceneRadianceProducer(device, { directionCount: DIRECTION_COUNT, maxDistance: T_MAX });
    producer.syncScene(packet);
    producer.syncLighting({ primary: SUN, ambient: AMBIENT });

    const layers = PROBES.length;
    const capture = device.createTexture({ label: "probe radiance evidence capture",
      size: { width: 1, height: 1, depthOrArrayLayers: layers }, dimension: "2d",
      mipLevelCount: 1, format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
    const view = capture.createView({ dimension: "2d-array", baseMipLevel: 0, mipLevelCount: 1,
      baseArrayLayer: 0, arrayLayerCount: layers });
    const plan = { profile: { gridSize: [1, 1, PROBES.length] }, updates: probeUpdates() };
    const encoder = device.createCommandEncoder({ label: "probe radiance evidence" });
    producer.encodeSourceRadiance({
      encoder, update: (plan.updates as ProbeUpdate[])[0]!, updateIndex: 0,
      destination: capture, destinationView: view, destinationOrigin: { x: 0, y: 0, z: 0 },
      context: { generation: 1, deviceEpoch: "evidence", plan: plan as never,
        signal: new AbortController().signal, resource: {} } as unknown as ProbeCaptureBeginContext,
    } as never);
    const readback = device.createBuffer({ label: "probe radiance evidence readback",
      size: 256 * layers, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyTextureToBuffer({ texture: capture }, { buffer: readback, bytesPerRow: 256,
      rowsPerImage: 1 }, { width: 1, height: 1, depthOrArrayLayers: layers });
    const overflowReadback = device.createBuffer({ label: "probe radiance overflow readback",
      size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    encoder.copyBufferToBuffer(producer.overflowEvidenceBuffer, 0, overflowReadback, 0, 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const words = new Uint16Array(readback.getMappedRange().slice(0));
    readback.unmap();
    await overflowReadback.mapAsync(GPUMapMode.READ);
    const overflowSentinel = new Uint32Array(overflowReadback.getMappedRange().slice(0))[0]!;
    overflowReadback.unmap();

    const cpuAlbedos: readonly (readonly [number, number, number])[] = [GROUND_ALBEDO, BOX_ALBEDO];
    const probes = PROBES.map((probe, index) => {
      // One probe per layer: layer L starts at half-word L*128 (bytesPerRow 256).
      const base = index * 128;
      const gpu: [number, number, number] = [decodeHalf(words[base]!), decodeHalf(words[base + 1]!),
        decodeHalf(words[base + 2]!)];
      const reference = cpuReferenceFor(packet, probe.position, cpuAlbedos);
      // One-flip allowance: a single f32/f64 silhouette flip changes exactly one direction's
      // contribution; the estimator can only differ by maxContribution / directionCount per
      // such flip (plus f16 storage quantization). Non-silhouette probes agree to ~1e-3.
      const maxContribution = Math.max(...reference.contributions
        .flat().map(value => Math.abs(value)));
      return { name: probe.name, position: probe.position, gpu, cpu: reference.mean,
        maxContribution, flipAllowance: maxContribution / DIRECTION_COUNT + 1e-3 };
    });
    const byName = new Map(probes.map(probe => [probe.name, probe]));
    const openSky = byName.get("open-sky")!, occluded = byName.get("occluded-below-box")!;
    const luminance = (value: readonly [number, number, number]): number =>
      value[0] + value[1] + value[2];
    return {
      probes,
      rawHalfWords: Array.from(words),
      overflowSentinel, validationMessages: [...validationMessages, ...errors],
      openSkyExceedsOccluded: luminance(openSky.gpu) > luminance(occluded.gpu),
      oneBounceEnergyPresent: luminance(openSky.gpu) > 0.01,
      adapter: (adapter as GPUAdapter & { info?: { description?: string } }).info?.description ?? "",
    };
  } finally { device.destroy(); }
}
