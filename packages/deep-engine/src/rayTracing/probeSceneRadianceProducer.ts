/// <reference types="@webgpu/types" />
/**
 * Deep GI 探针一跳场景辐射 GPU 生产者（F1 第一切片）：`encodeSourceRadiance` 钩子的
 * 第一个真实实现。把 RenderPacket 经 buildRenderPacketRayScene → packTlasScene 上传为
 * 两级软件 TLAS/BLAS 存储缓冲，按渲染帧锁存的直射光/环境项，对捕获计划里的每个探针
 * 发射确定性 Fibonacci 方向集（≤16/探针），命中点 Lambert 一跳着色、miss 记环境项，
 * 均值写入捕获纹理对应 texel（probeRadianceKernel）。
 *
 * == 诚实边界 ==
 * 一跳直射+环境估计：命中点不追第二次阴影射线；MASK 纹理 alpha、BLEND、动态形变按
 * RenderPacketRayScene 既有排除/拒绝口径（deformation packet 直接抛错 → 调用方
 * fail-closed 回退 IBL）。无真实辐射源（光强与能量均为 0）时拒绝编码并保持 IBL，
 * 禁止把黑色体积发布为 GI。场景变更按 packet 身份去重；批次经生产者序列化合同
 * （executor 对每批 await submit 后才开始下一批）复用单一 uniform/探针参数缓冲。
 */

import type { ProbeUpdate } from "../lighting/probeClipmapPlan.js";
import type { RenderPacket } from "../renderPacket.js";
import { runResourceCleanup } from "../webgpu/resourceCleanup.js";
import type { WebGpuProbeRadianceContext } from "../webgpu/webgpuProbeCaptureTypes.js";
import {
  emitProbeRadianceKernelWgsl, packProbeRadianceProbeParams, packProbeRadianceUniform,
  PROBE_RADIANCE_ENTRY_POINT, PROBE_RADIANCE_MAX_DIRECTIONS, PROBE_RADIANCE_PROBE_PARAM_BYTES,
  PROBE_RADIANCE_UNIFORM_BYTES,
} from "./probeRadianceKernel.js";
import {
  buildRenderPacketRayScene, RENDER_PACKET_GI_RAY_MASK, type RenderPacketRayScene,
} from "./renderPacketRayScene.js";
import { probeOcclusionDirection } from "./probeOcclusionRayExtension.js";
import { packTlasScene, type TlasPackedScene } from "./tlasLayout.js";

/** 渲染帧锁存给生产者的真实辐射输入（PbrRenderer 逐帧馈送）。 */
export interface ProbeRadianceLighting {
  /** 已解析的主直射光；undefined = 作者未启用方向光。 */
  readonly primary?: {
    readonly surfaceToLightWorld: readonly [number, number, number];
    readonly color: readonly [number, number, number];
    readonly intensity: number;
  };
  /** 环境项（本切片由宿主以 [0,0,0] 起步；接口就绪，环境均值读回属后续切片）。 */
  readonly ambient: readonly [number, number, number];
}

export interface ProbeSceneRadianceProducerOptions {
  /** 每探针确定性方向数，1..16 整数；默认 8。 */
  readonly directionCount?: number;
  /** 射线最大行程（世界单位，(0, 1e6]）；默认 32。 */
  readonly maxDistance?: number;
}

export interface ProbeSceneRadianceBatchStats {
  readonly generation: number;
  readonly updates: number;
  readonly directionCount: number;
  readonly maxDistance: number;
  readonly sceneInstances: number;
}

interface ProbeRadianceVector3 {
  readonly 0: number;
  readonly 1: number;
  readonly 2: number;
}

const WORKGROUP = 64;

/** Real-GPU one-bounce scene radiance producer behind the probe capture hook. */
export class ProbeSceneRadianceProducer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPUComputePipeline;
  private readonly uniform: GPUBuffer;
  private readonly overflow: GPUBuffer;
  private sceneNodes: GPUBuffer | undefined;
  private sceneInstances: GPUBuffer | undefined;
  private sceneVertices: GPUBuffer | undefined;
  private sceneIndices: GPUBuffer | undefined;
  private sceneOrder: GPUBuffer | undefined;
  private sceneAlbedos: GPUBuffer | undefined;
  private probeParams: GPUBuffer | undefined;
  private scene: RenderPacketRayScene | undefined;
  private packed: TlasPackedScene | undefined;
  private scenePacket: RenderPacket | undefined;
  private sceneReady = false;
  private sceneError: string | undefined;
  private probeParamsCapacity = 0;
  private lighting: ProbeRadianceLighting | undefined;
  private lastGeneration = -1;
  private lastBatch: ProbeSceneRadianceBatchStats | undefined;
  private directionCount: number;
  private maxDistance: number;
  private disposed = false;

  constructor(device: GPUDevice, options: ProbeSceneRadianceProducerOptions = {}) {
    this.device = device;
    this.directionCount = options.directionCount ?? 8;
    if (!Number.isSafeInteger(this.directionCount) || this.directionCount < 1
      || this.directionCount > PROBE_RADIANCE_MAX_DIRECTIONS) {
      throw new RangeError(`Probe radiance directionCount must be an integer in [1, ${PROBE_RADIANCE_MAX_DIRECTIONS}].`);
    }
    this.maxDistance = options.maxDistance ?? 32;
    if (!Number.isFinite(this.maxDistance) || this.maxDistance <= 0 || this.maxDistance > 1_000_000) {
      throw new RangeError("Probe radiance maxDistance must be in (0, 1000000].");
    }
    const module = device.createShaderModule({ label: "Deep GI probe scene radiance kernel",
      code: emitProbeRadianceKernelWgsl() });
    const layout = device.createBindGroupLayout({ label: "Deep GI probe scene radiance layout",
      entries: [
        storageReadLayout(0), storageReadLayout(1), storageReadLayout(2), storageReadLayout(3),
        storageReadLayout(4), storageReadLayout(5), storageReadLayout(6),
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, storageTexture: {
          access: "write-only", format: "rgba16float", viewDimension: "2d-array" } },
        { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ] });
    this.pipeline = device.createComputePipeline({ label: "Deep GI probe scene radiance pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: PROBE_RADIANCE_ENTRY_POINT } });
    this.uniform = device.createBuffer({ label: "Deep GI probe radiance params", size: PROBE_RADIANCE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.overflow = device.createBuffer({ label: "Deep GI probe radiance overflow sentinel", size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  }

  /** Latest latched lighting; capture batches pack it at encode time. */
  get currentLighting(): ProbeRadianceLighting | undefined { return this.lighting; }
  get sceneInstanceCount(): number { return this.scene?.materials.length ?? 0; }
  get lastBatchStats(): ProbeSceneRadianceBatchStats | undefined { return this.lastBatch; }
  get disposedFlag(): boolean { return this.disposed; }
  /** Evidence path: the batch overflow sentinel (COPY_SRC; 0 = every traversal completed). */
  get overflowEvidenceBuffer(): GPUBuffer { return this.overflow; }
  /** Set when the latest packet cannot be captured (deformation snapshots, invalid references). */
  get sceneUnavailableReason(): string | undefined { return this.sceneError; }

  /** Soft-fail path for hosts that must survive invalid packets (probe GI degrades, loop lives). */
  markSceneUnavailable(reason: string): void {
    this.sceneReady = false;
    this.sceneError = reason;
    this.releaseSceneBuffers();
    this.scene = undefined; this.packed = undefined; this.scenePacket = undefined;
  }

  /** Renders the packet into the two-level ray scene; invalid packets throw (caller fails closed). */
  syncScene(packet: RenderPacket): void {
    this.assertAlive();
    if (this.scenePacket === packet) return;
    this.sceneError = undefined;
    let scene: RenderPacketRayScene;
    let packed: TlasPackedScene;
    try {
      scene = buildRenderPacketRayScene(packet);
      packed = packTlasScene(scene.tlas);
    } catch (error) {
      this.markSceneUnavailable(error instanceof Error ? error.message : String(error));
      throw error;
    }
    this.scene = scene; this.packed = packed; this.scenePacket = packet;
    if (scene.materials.length === 0) {
      // All-transparent (or empty) packets have no opaque radiance capture target; keep the
      // hook fail-closed so a scheduled capture refuses instead of binding empty buffers.
      this.releaseSceneBuffers();
      this.sceneReady = false;
      return;
    }
    const albedos = new Float32Array(scene.materials.length * 4);
    scene.materials.forEach((binding, index) => {
      albedos.set([...binding.material.baseColor, 1], index * 4);
    });
    this.sceneNodes = this.upload("nodes", packed.nodeBytes, this.sceneNodes);
    this.sceneInstances = this.upload("instances", packed.recordBytes, this.sceneInstances);
    this.sceneVertices = this.upload("vertices", new Float32Array(packed.vertices), this.sceneVertices);
    this.sceneIndices = this.upload("indices", new Uint32Array(packed.indices), this.sceneIndices);
    this.sceneOrder = this.upload("order", new Uint32Array(packed.order), this.sceneOrder);
    this.sceneAlbedos = this.upload("albedos", albedos, this.sceneAlbedos);
    this.sceneReady = true;
  }

  /** Per-frame lighting latch; later captures pack whatever was latest at their encode time. */
  syncLighting(input: ProbeRadianceLighting): void {
    this.assertAlive();
    validateLighting(input);
    this.lighting = input;
  }

  /**
   * The capture hook: one compute dispatch per transaction (first call encodes the whole
   * update batch; repeat calls for the same generation are idempotent no-ops).
   */
  encodeSourceRadiance(context: WebGpuProbeRadianceContext): void {
    this.assertAlive();
    const plan = context.context.plan;
    const generation = context.context.generation;
    const updates = plan.updates;
    if (generation === this.lastGeneration || updates.length === 0) return;
    if (!this.sceneReady) {
      throw new Error(`Probe scene radiance capture is unavailable (${this.sceneError ?? "no opaque scene geometry"}); keep IBL.`);
    }
    const light = this.lighting;
    if (!light || !hasRealRadianceSource(light)) {
      throw new Error("Probe scene radiance capture requires a real radiance source; keep IBL instead of a dark volume.");
    }
    const probeParams = this.ensureProbeParams(updates.length);
    const primary = light.primary;
    const direction = normalize3(primary?.surfaceToLightWorld ?? [0, 1, 0]);
    this.lastGeneration = generation;
    const layerOf = (update: ProbeUpdate): number =>
      update.localCell[2] + update.level * plan.profile.gridSize[2];
    this.device.queue.writeBuffer(this.uniform, 0, packProbeRadianceUniform({
      updateCount: updates.length, directionCount: this.directionCount,
      rayMask: RENDER_PACKET_GI_RAY_MASK, tMax: this.maxDistance,
      surfaceToLight: direction,
      lightColor: primary?.color ?? [0, 0, 0], lightIntensity: primary?.intensity ?? 0,
      ambient: light.ambient,
      // CPU authority: the same probeOcclusionDirection the CPU reference uses, so the
      // GPU never recomputes (and never drifts from) the direction set.
      directions: Array.from({ length: this.directionCount }, (_, ordinal) =>
        probeOcclusionDirection(ordinal, this.directionCount)) }));
    this.device.queue.writeBuffer(probeParams, 0, packProbeRadianceProbeParams(updates.map(
      update => ({ position: update.position, layer: layerOf(update),
        cellX: update.localCell[0], cellY: update.localCell[1] }))));
    this.device.queue.writeBuffer(this.overflow, 0, new Uint32Array(1));
    const bindGroup = this.device.createBindGroup({ label: "Deep GI probe scene radiance bindings",
      layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.sceneNodes! } },
        { binding: 1, resource: { buffer: this.sceneInstances! } },
        { binding: 2, resource: { buffer: this.sceneVertices! } },
        { binding: 3, resource: { buffer: this.sceneIndices! } },
        { binding: 4, resource: { buffer: this.sceneOrder! } },
        { binding: 5, resource: { buffer: this.sceneAlbedos! } },
        { binding: 6, resource: { buffer: this.probeParams! } },
        { binding: 7, resource: { buffer: this.uniform } },
        { binding: 8, resource: context.destinationView },
        { binding: 9, resource: { buffer: this.overflow } },
      ] });
    const pass = context.encoder.beginComputePass({ label: "Deep GI probe scene radiance capture" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(updates.length / WORKGROUP));
    pass.end();
    this.lastBatch = Object.freeze({ generation, updates: updates.length,
      directionCount: this.directionCount, maxDistance: this.maxDistance,
      sceneInstances: this.scene!.materials.length });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene = undefined; this.packed = undefined; this.scenePacket = undefined;
    runResourceCleanup("Probe scene radiance producer disposal failed.", [
      () => this.uniform.destroy(), () => this.overflow.destroy(),
      ...[this.sceneNodes, this.sceneInstances, this.sceneVertices, this.sceneIndices,
        this.sceneOrder, this.sceneAlbedos, this.probeParams]
        .map(buffer => () => buffer?.destroy()),
    ]);
  }

  private upload(label: string, data: GPUAllowSharedBufferSource,
    previous: GPUBuffer | undefined): GPUBuffer {
    previous?.destroy();
    const byteLength = data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
    const buffer = this.device.createBuffer({ label: `Deep GI probe radiance scene ${label}`,
      size: byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private releaseSceneBuffers(): void {
    [this.sceneNodes, this.sceneInstances, this.sceneVertices, this.sceneIndices,
      this.sceneOrder, this.sceneAlbedos].forEach(buffer => buffer?.destroy());
    this.sceneNodes = undefined; this.sceneInstances = undefined; this.sceneVertices = undefined;
    this.sceneIndices = undefined; this.sceneOrder = undefined; this.sceneAlbedos = undefined;
  }

  private ensureProbeParams(updateCount: number): GPUBuffer {
    if (this.probeParams && this.probeParamsCapacity >= updateCount) return this.probeParams;
    const capacity = Math.max(updateCount, 64);
    this.probeParams?.destroy();
    this.probeParams = this.device.createBuffer({ label: "Deep GI probe radiance probe params",
      size: capacity * PROBE_RADIANCE_PROBE_PARAM_BYTES,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.probeParamsCapacity = capacity;
    return this.probeParams;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("Probe scene radiance producer is disposed.");
  }
}

function hasRealRadianceSource(light: ProbeRadianceLighting): boolean {
  const direct = light.primary;
  const directEnergy = direct ? direct.intensity * channelSum(direct.color) : 0;
  return directEnergy > 0 || channelSum(light.ambient) > 0;
}
function channelSum(value: ProbeRadianceVector3): number {
  return value[0] + value[1] + value[2];
}
function normalize3(value: readonly [number, number, number]): readonly [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 0)) return [0, 1, 0];
  return [value[0] / length, value[1] / length, value[2] / length];
}
function validateLighting(input: ProbeRadianceLighting): void {
  const vectors = [input.ambient, ...(input.primary ? [input.primary.surfaceToLightWorld, input.primary.color] : [])];
  vectors.forEach((vector, index) => {
    if (!Array.isArray(vector) || vector.length !== 3
      || vector.some(channel => typeof channel !== "number" || !Number.isFinite(channel))) {
      throw new RangeError(`Probe radiance lighting vector ${index} must contain three finite channels.`);
    }
  });
  if (input.primary && (!Number.isFinite(input.primary.intensity) || input.primary.intensity < 0)) {
    throw new RangeError("Probe radiance primary intensity must be finite and non-negative.");
  }
}
function storageReadLayout(binding: number): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } };
}
