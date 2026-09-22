/**
 * F1 归因验证（第二轮）：用生产内核源码（emitProbeRadianceKernelWgsl）的同一份
 * probeTraceClosest/fibonacciDirection，追加一个只读调试入口，把逐方向
 * (hit, t, prim, instance) 落到 storage buffer。
 * 目的：证明 0.0075 均值偏差到底来自"方向舍入翻转"还是内核缺陷。
 * 这是 lab 证据文件，不进入生产路径。
 */

import type { RenderPacket } from "../src/renderPacket.js";
import { ProbeSceneRadianceProducer } from "../src/rayTracing/probeSceneRadianceProducer.js";
import { emitProbeRadianceKernelWgsl } from "../src/rayTracing/probeRadianceKernel.js";
import { buildRenderPacketRayScene, RENDER_PACKET_GI_RAY_MASK } from "../src/rayTracing/renderPacketRayScene.js";
import { probeOcclusionDirection } from "../src/rayTracing/probeOcclusionRayExtension.js";
import { traceTlasClosest } from "../src/rayTracing/tlas.js";

const DIRECTION_COUNT = 8, T_MAX = 32;
const PROBE: readonly [number, number, number] = [0.37, 0.5, 0.21];
const SUN = { surfaceToLightWorld: [0, 1, 0], color: [1, 1, 1], intensity: 3 } as const;
const AMBIENT = [0.05, 0.05, 0.06] as const;

function radianceCasePacket(): RenderPacket {
  const size = 10;
  const ground = new Float32Array([
    -size, 0, -size, 0, 1, 0, size, 0, -size, 0, 1, 0, size, 0, size, 0, 1, 0,
    -size, 0, -size, 0, 1, 0, size, 0, size, 0, 1, 0, -size, 0, size, 0, 1, 0]);
  const h = 0.5, lo = -h, hi = h, cy = 1.5;
  const v = (x: number, y: number, z: number): number[] => [x, cy + y, z];
  const boxFaces: number[][][] = [
    [[lo, hi, lo], [lo, hi, hi], [hi, hi, hi], [lo, hi, lo], [hi, hi, hi], [hi, hi, lo]],
    [[lo, lo, lo], [hi, lo, lo], [hi, lo, hi], [lo, lo, lo], [hi, lo, hi], [lo, lo, hi]],
    [[lo, lo, hi], [hi, lo, hi], [hi, hi, hi], [lo, lo, hi], [hi, hi, hi], [lo, hi, hi]],
    [[hi, lo, lo], [lo, lo, lo], [lo, hi, lo], [hi, lo, lo], [lo, hi, lo], [hi, hi, lo]],
    [[hi, lo, hi], [hi, lo, lo], [hi, hi, lo], [hi, lo, hi], [hi, hi, lo], [hi, hi, hi]],
    [[lo, lo, lo], [lo, lo, hi], [lo, hi, hi], [lo, lo, lo], [lo, hi, hi], [lo, hi, lo]],
  ];
  const normals: number[][] = [[0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], [-1, 0, 0]];
  const boxVertices: number[] = [];
  boxFaces.forEach((face, index) => face.forEach(vertex => boxVertices.push(
    ...v(vertex[0] as number, vertex[1] as number, vertex[2] as number), ...normals[index]!)));
  return {
    geometries: [
      { id: "ground", revision: 0, vertices: ground, indices: new Uint32Array([0, 1, 2, 3, 4, 5]) },
      { id: "box", revision: 0, vertices: new Float32Array(boxVertices),
        indices: new Uint32Array(Array.from({ length: 36 }, (_, index) => index)) },
    ],
    materials: [
      { id: "ground-m", baseColor: [0.6, 0.55, 0.5], metallic: 0, roughness: 1 },
      { id: "box-m", baseColor: [0.2, 0.8, 0.4], metallic: 0, roughness: 1 },
    ],
    instances: [
      { id: "ground-1", geometry: "ground", material: "ground-m",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      { id: "box-1", geometry: "box", material: "box-m",
        transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ],
  };
}

export interface KernelDirectionDump {
  readonly kernel: readonly { ordinal: number; hit: boolean; t: number; prim: number; instance: number }[];
  readonly cpu: readonly { ordinal: number; hit: boolean; t: number; prim: number }[];
  readonly mismatches: readonly number[];
}

export async function runKernelDirectionDump(): Promise<KernelDirectionDump> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  // The debug entry point adds a 9th storage buffer on top of the production kernel's 8,
  // so this lab-only probe raises the per-stage limit (production stays at the default 8).
  const device = await adapter.requestDevice({ label: "kernel-direction-dump",
    requiredLimits: { maxStorageBuffersPerShaderStage:
      Math.max(9, adapter.limits.maxStorageBuffersPerShaderStage) } });
  try {
    const packet = radianceCasePacket();
    const producer = new ProbeSceneRadianceProducer(device, { directionCount: DIRECTION_COUNT, maxDistance: T_MAX });
    producer.syncScene(packet);
    producer.syncLighting({ primary: SUN, ambient: AMBIENT });

    // Debug module: the production kernel source + an extra entry point reusing its traversal.
    const debugSource = `${emitProbeRadianceKernelWgsl()}
@group(0) @binding(10) var<storage, read_write> dumpHits: array<vec4f>;
@compute @workgroup_size(64)
fn dump_probe_directions(@builtin(global_invocation_id) gid: vec3u) {
  let probeIndex = gid.x;
  if (probeIndex >= params.updateCount) { return; }
  let probe = probeParams[probeIndex];
  let origin = probe.posLayer.xyz;
  for (var ordinal: u32 = 0u; ordinal < params.directionCount; ordinal = ordinal + 1u) {
    let dir = params.directions[ordinal].xyz;
    let inv = vec3f(1.0 / dir.x, 1.0 / dir.y, 1.0 / dir.z);
    var prim = SENTINEL;
    var instance = SENTINEL;
    let t = probeTraceClosest(origin, dir, inv, params.tMax, &prim, &instance);
    dumpHits[probeIndex * params.directionCount + ordinal] =
      vec4f(select(0.0, 1.0, prim != SENTINEL), t, f32(prim), f32(instance));
  }
}`;
    const module = device.createShaderModule({ label: "probe radiance debug dump", code: debugSource });
    const info = await module.getCompilationInfo();
    const diagnostics = info.messages.filter(m => m.type !== "info")
      .map(m => `${m.type}:${m.lineNum}:${m.message}`);
    if (diagnostics.length) throw new Error(`Debug module failed to compile: ${diagnostics.join("; ")}`);

    const storage = (binding: number) => ({ binding, visibility: GPUShaderStage.COMPUTE,
      buffer: { type: "read-only-storage" as const } });
    const layout = device.createBindGroupLayout({ label: "probe radiance debug layout", entries: [
      storage(0), storage(1), storage(2), storage(3), storage(4), storage(5), storage(6),
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: {
        access: "write-only", format: "rgba16float", viewDimension: "2d-array" } },
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 10, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ] });
    device.pushErrorScope("validation");
    const pipeline = device.createComputePipeline({ label: "probe radiance debug pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: "dump_probe_directions" } });

    const dumpBuffer = device.createBuffer({ label: "probe direction dump",
      size: 16 * DIRECTION_COUNT, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ label: "probe direction dump readback",
      size: 16 * DIRECTION_COUNT, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const capture = device.createTexture({ label: "dump capture placeholder",
      size: { width: 1, height: 1, depthOrArrayLayers: 1 }, format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING });
    const view = capture.createView({ dimension: "2d-array", arrayLayerCount: 1 });

    // The producer owns the scene/uniform buffers; rebuild an equivalent binding set here by
    // re-creating the same buffers through a second producer instance would diverge — instead
    // the debug pass reuses the producer's own pipeline-visible resources via a fresh producer.
    // Simplest honest path: run the dump with the producer's own uniforms by asking it to
    // encode a zero-probe batch is not possible, so the debug pass gets its own copies.
    const kernelUniform = device.createBuffer({ label: "debug uniform", size: 320,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const probeParams = device.createBuffer({ label: "debug probe params", size: 64,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const overflow = device.createBuffer({ label: "debug overflow", size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    // Mirror the producer's scene buffers by capturing them through a scene sync on this device.
    const sceneBuffers = await rebuildSceneBuffers(device, packet);

    const uniformData = new ArrayBuffer(320);
    new Uint32Array(uniformData, 0, 3).set([1, DIRECTION_COUNT, RENDER_PACKET_GI_RAY_MASK]);
    new Float32Array(uniformData, 12, 1)[0] = T_MAX;
    const floats = new Float32Array(uniformData);
    floats.set([0, 1, 0, SUN.intensity], 4);
    floats.set([...SUN.color, 0], 8);
    floats.set([...AMBIENT, 0], 12);
    for (let ordinal = 0; ordinal < DIRECTION_COUNT; ordinal++) {
      const [dx, dy, dz] = probeOcclusionDirection(ordinal, DIRECTION_COUNT);
      floats.set([dx, dy, dz, 0], 16 + ordinal * 4);
    }
    device.queue.writeBuffer(kernelUniform, 0, uniformData);
    const paramData = new Float32Array(16);
    paramData.set([PROBE[0], PROBE[1], PROBE[2], 0, 0, 0, 0, 0]);
    device.queue.writeBuffer(probeParams, 0, paramData);
    device.queue.writeBuffer(overflow, 0, new Uint32Array(1));

    const bindGroup = device.createBindGroup({ label: "debug bindings", layout, entries: [
      { binding: 0, resource: { buffer: sceneBuffers.nodes } },
      { binding: 1, resource: { buffer: sceneBuffers.instances } },
      { binding: 2, resource: { buffer: sceneBuffers.vertices } },
      { binding: 3, resource: { buffer: sceneBuffers.indices } },
      { binding: 4, resource: { buffer: sceneBuffers.order } },
      { binding: 5, resource: { buffer: sceneBuffers.albedos } },
      { binding: 6, resource: { buffer: probeParams } },
      { binding: 7, resource: { buffer: kernelUniform } },
      { binding: 8, resource: view },
      { binding: 9, resource: { buffer: overflow } },
      { binding: 10, resource: { buffer: dumpBuffer } },
    ] });
    const bindGroupError = await device.popErrorScope();
    if (bindGroupError) throw new Error(`Debug bind group/pipeline validation: ${bindGroupError.message}`);
    device.pushErrorScope("validation");
    const encoder = device.createCommandEncoder({ label: "kernel direction dump" });
    const pass = encoder.beginComputePass({ label: "dump directions" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(dumpBuffer, 0, readback, 0, 16 * DIRECTION_COUNT);
    device.queue.submit([encoder.finish()]);
    const encodeError = await device.popErrorScope();
    if (encodeError) throw new Error(`Debug encode/submit validation: ${encodeError.message}`);
    await readback.mapAsync(GPUMapMode.READ);
    const words = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();

    const scene = buildRenderPacketRayScene(packet);
    const kernel = Array.from({ length: DIRECTION_COUNT }, (_, ordinal) => {
      const base = ordinal * 4;
      return { ordinal, hit: words[base]! > 0.5, t: words[base + 1]!, prim: words[base + 2]!,
        instance: words[base + 3]! };
    });
    const cpu = Array.from({ length: DIRECTION_COUNT }, (_, ordinal) => {
      const [dx, dy, dz] = probeOcclusionDirection(ordinal, DIRECTION_COUNT);
      const hit = traceTlasClosest(scene.tlas, { ox: PROBE[0], oy: PROBE[1], oz: PROBE[2],
        dx, dy, dz, tMax: T_MAX }, RENDER_PACKET_GI_RAY_MASK);
      return { ordinal, hit: hit !== undefined, t: hit?.t ?? -1, prim: hit?.primitiveIndex ?? -1 };
    });
    return { kernel, cpu,
      mismatches: kernel.filter((entry, index) => entry.hit !== cpu[index]!.hit).map(entry => entry.ordinal) };
  } finally { device.destroy(); }
}

/** Rebuild the packed scene buffers locally (mirrors the producer's upload path). */
async function rebuildSceneBuffers(device: GPUDevice, packet: RenderPacket) {
  const scene = buildRenderPacketRayScene(packet);
  const { packTlasScene } = await import("../src/rayTracing/tlasLayout.js");
  const packed = packTlasScene(scene.tlas);
  const albedos = new Float32Array(scene.materials.length * 4);
  scene.materials.forEach((binding, index) => { albedos.set([...binding.material.baseColor, 1], index * 4); });
  const upload = (label: string, data: GPUAllowSharedBufferSource) => {
    const size = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
    const buffer = device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  };
  return {
    nodes: upload("dump nodes", packed.nodeBytes),
    instances: upload("dump instances", packed.recordBytes),
    vertices: upload("dump vertices", new Float32Array(packed.vertices)),
    indices: upload("dump indices", new Uint32Array(packed.indices)),
    order: upload("dump order", new Uint32Array(packed.order)),
    albedos: upload("dump albedos", albedos),
  };
}
