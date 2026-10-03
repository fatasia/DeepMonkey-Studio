/// <reference types="@webgpu/types" />
/**
 * G1-S1 簇级微多边形绘制槽位（opt-in，PbrRendererOptions.clusterLod）。
 * 把既有合同链接进默认帧：bake DAG（clusterLodBake 产物，由宿主 stage）→
 * GPU select_cluster_lod（clusterLodSelectionKernel，逐节点独立判定）→ 读回槽位 →
 * planClusterLodIndirect（前沿闭合 + fail-closed 校验）→ ClusterLodIndirectExecutor
 * 命令上传/RenderBundle → 主 opaque pass executeBundles(drawIndexedIndirect)。
 *
 * == 帧内时序（一帧选层延迟，与粒子运行时同款异步纪律） ==
 * 帧 N：updateCamera（写 48B 相机 uniform）→ encodeFrame 在主 encoder 追加 compute pass +
 * selection/faults 读回拷贝 → 主 pass 用帧 N−1 的 bundle 绘制 → submit 后 ingest() 异步
 * mapAsync 读回 → 派生 plan/命令。相机静止时签名相等，encode 跳过、命令与 bundle 全复用。
 *
 * == fail-closed（绝不静默降级） ==
 * 选层 faults 哨兵非零、读回槽位违反选层合同（planClusterLodIndirect 抛错）、命令超预算
 * （executor.encode 抛错）、帧签名不支持（MRT/directDisplay）——一律清空执行、sticky
 * fallbackReason 上浮到 FrameMetrics.clusterLod.fallbackReason，后续帧不再绘制；
 * 恢复唯一途径是重新 stageClusterLodScene。staging 校验（DAG 合同/层数/像素阈值）在
 * create 处直接抛错。
 */

import { DeviceSession } from "./deviceSession.js";
import { ClusterLodIndirectExecutor, type ClusterLodExecutionPlan, type ClusterLodGeometryBuffers,
  type ClusterLodRenderRequest } from "./clusterLodIndirectExecutor.js";
import { packClusterLodCamera, packClusterLodNodes, CLUSTER_LOD_SELECTION_WORKGROUP_SIZE,
  CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD, type ClusterLodCamera } from "../rayTracing/clusterLodSelection.js";
import { emitClusterLodSelectionWgsl, CLUSTER_LOD_SELECTION_ENTRY_POINT,
} from "../rayTracing/clusterLodSelectionKernel.js";
import { planClusterLodIndirect, type ClusterLodLevelGeometrySummary } from "../rayTracing/clusterLodIndirectPlan.js";
import { validateClusterLodDag, type ClusterLodDagDescriptor } from "../rayTracing/clusterLodDag.js";
import { concatenateLevelGeometry, createClusterLodSlotRenderResources, deriveClusterLodCamera,
  packClusterLodViewProjection, readBackWords, type RenderViewCamera } from "./clusterLodSlotSupport.js";
import { PBR_DEPTH_FORMAT, PBR_HDR_FORMAT } from "./renderTargets.js";

/** 宿主 stage 输入：bake 产物（clusterLodBake）+ 可选像素阈值（默认 1px，Nanite 式感知阈值）。 */
export interface ClusterLodSceneStaging {
  readonly dag: ClusterLodDagDescriptor;
  readonly levelGeometry: ReadonlyArray<{ readonly vertices: Float32Array; readonly indices: Uint32Array }>;
  readonly pixelThreshold?: number;
}

export interface ClusterLodSlotMetrics {
  /** 前沿 indirect 命令数（GPU 真实绘制命令数；bundle 在 CPU 侧计 1 次 executeBundles）。 */
  readonly draws: number;
  readonly triangles: number;
  readonly generation: number;
  readonly frontierMaxLevel: number;
  /** 有更新选层在途（相机已变或读回未归），当前 bundle 相对相机滞后 ≤1 帧。 */
  readonly stale: boolean;
  /** 尚无任何可用 bundle（首帧/选层在途），且无 fallback。 */
  readonly warming: boolean;
  readonly fallbackReason?: string;
}

export interface ClusterLodDrawStats { readonly draws: number; readonly triangles: number }

const ZERO_FAULTS = new Uint32Array([0]);

export class ClusterLodRenderSlot {
  private readonly executor: ClusterLodIndirectExecutor;
  private readonly request: ClusterLodRenderRequest;
  private readonly geometry: ClusterLodGeometryBuffers;
  private readonly summaries: readonly ClusterLodLevelGeometrySummary[];
  private readonly computePipeline: GPUComputePipeline;
  private readonly computeBindGroup: GPUBindGroup;
  private readonly nodesBuffer: GPUBuffer;
  private readonly selectionBuffer: GPUBuffer;
  private readonly faultsBuffer: GPUBuffer;
  private readonly cameraBuffer: GPUBuffer;
  private readonly selectionStaging: GPUBuffer;
  private readonly faultsStaging: GPUBuffer;
  private readonly viewProjectionBuffer: GPUBuffer;
  private readonly owned: GPUBuffer[];
  private readonly pixelThreshold: number;
  private readonly nodeCount: number;
  private readonly stagedDag: ClusterLodDagDescriptor;
  private lastCamera: ClusterLodCamera | undefined;
  private cameraDirty = false;
  private pendingReadback = false;
  private execution: ClusterLodExecutionPlan | undefined;
  private drawnTriangles = 0;
  private frontierMaxLevel = 0;
  private fallbackReason: string | undefined;
  private evidenceSelection: Uint32Array | undefined;
  private evidenceFrontier: readonly string[] | undefined;
  private disposed = false;

  private constructor(private readonly session: DeviceSession, staging: ClusterLodSceneStaging,
    /** AA-M1:主 pass 生效采样数(槽位 bundle 在主 pass 内执行,必须与附件一致)。 */
    mainSampleCount: 1 | 4 = 1) {
    const validation = validateClusterLodDag(staging.dag);
    if (!validation.valid) throw new Error(`Cluster LOD slot staging rejected: ${validation.reason}`);
    this.pixelThreshold = staging.pixelThreshold ?? CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD;
    if (!Number.isFinite(this.pixelThreshold) || this.pixelThreshold <= 0) {
      throw new Error("Cluster LOD slot pixelThreshold must be finite and positive.");
    }
    const levels = staging.levelGeometry;
    if (levels.length === 0) throw new Error("Cluster LOD slot staging requires level geometry.");
    for (const [level, geometry] of levels.entries()) {
      if (geometry.vertices.length % 3 !== 0 || geometry.indices.length % 3 !== 0
        || !geometry.vertices.every(Number.isFinite)) {
        throw new Error(`Cluster LOD slot level ${level} geometry is malformed.`);
      }
    }
    const maxLevel = Math.max(...staging.dag.nodes.map(node => node.level));
    if (levels.length <= maxLevel) throw new Error("Cluster LOD slot staging lacks coarse-level geometry.");
    this.stagedDag = staging.dag;
    this.nodeCount = staging.dag.nodes.length;
    this.summaries = levels.map(geometry => ({ vertexCount: geometry.vertices.length / 3,
      indexCount: geometry.indices.length }));
    const device = session.device;
    const nodeBytes = packClusterLodNodes(staging.dag);
    this.nodesBuffer = this.own(device.createBuffer({ label: "Deep cluster LOD slot nodes",
      size: nodeBytes.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(this.nodesBuffer, 0, nodeBytes);
    this.selectionBuffer = this.own(device.createBuffer({ label: "Deep cluster LOD slot selection",
      size: this.nodeCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }));
    this.faultsBuffer = this.own(device.createBuffer({ label: "Deep cluster LOD slot faults",
      size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }));
    this.cameraBuffer = this.own(device.createBuffer({ label: "Deep cluster LOD slot camera",
      size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.selectionStaging = this.own(device.createBuffer({ label: "Deep cluster LOD slot selection readback",
      size: this.nodeCount * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    this.faultsStaging = this.own(device.createBuffer({ label: "Deep cluster LOD slot faults readback",
      size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const concatenated = concatenateLevelGeometry(levels);
    const vertexBuffer = this.own(device.createBuffer({ label: "Deep cluster LOD slot vertices",
      size: concatenated.vertices.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(vertexBuffer, 0, concatenated.vertices);
    const indexBuffer = this.own(device.createBuffer({ label: "Deep cluster LOD slot indices",
      size: concatenated.indices.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST }));
    device.queue.writeBuffer(indexBuffer, 0, concatenated.indices);
    this.geometry = { vertexBuffer, indexBuffer, vertexSize: concatenated.vertices.byteLength,
      indexSize: concatenated.indices.byteLength };
    this.owned = [this.nodesBuffer, this.selectionBuffer, this.faultsBuffer, this.cameraBuffer,
      this.selectionStaging, this.faultsStaging, vertexBuffer, indexBuffer];
    const module = device.createShaderModule({ label: "Deep cluster LOD slot selection",
      code: emitClusterLodSelectionWgsl() });
    this.computePipeline = device.createComputePipeline({ label: "Deep cluster LOD slot selection",
      layout: "auto", compute: { module, entryPoint: CLUSTER_LOD_SELECTION_ENTRY_POINT } });
    this.computeBindGroup = device.createBindGroup({ layout: this.computePipeline.getBindGroupLayout(0),
      entries: [this.nodesBuffer, this.selectionBuffer, this.faultsBuffer, this.cameraBuffer]
        .map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const resources = createClusterLodSlotRenderResources(session,
      packClusterLodViewProjection([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), mainSampleCount);
    this.viewProjectionBuffer = resources.viewProjectionBuffer;
    this.owned.push(this.viewProjectionBuffer);
    this.request = { pipeline: resources.pipeline, colorFormats: [PBR_HDR_FORMAT],
      depthStencilFormat: PBR_DEPTH_FORMAT, sampleCount: mainSampleCount,
      bindGroups: [{ index: 0, bindGroup: resources.bindGroup }] };
    this.executor = new ClusterLodIndirectExecutor(session);
  }

  static create(session: DeviceSession, staging: ClusterLodSceneStaging, mainSampleCount: 1 | 4 = 1): ClusterLodRenderSlot {
    return new ClusterLodRenderSlot(session, staging, mainSampleCount);
  }

  /** 由 RenderView 推导选层相机（内部分辨率 + 本槽位像素阈值）；相机未变时零 GPU 写。 */
  updateCameraFromView(view: RenderViewCamera, viewportHeightPixels: number, verticalFovRadians: number): void {
    this.updateCamera(deriveClusterLodCamera(view, viewportHeightPixels, verticalFovRadians, this.pixelThreshold));
  }

  updateCamera(camera: ClusterLodCamera): void {
    this.assertReady();
    if (this.sameCamera(camera)) return;
    this.session.device.queue.writeBuffer(this.cameraBuffer, 0, packClusterLodCamera(camera, this.nodeCount));
    this.lastCamera = camera;
    this.cameraDirty = true;
  }

  /** 主 encoder 追加选层 compute pass 与读回拷贝；相机未变或上一读回在途时跳过（返回 false）。 */
  encodeFrame(encoder: GPUCommandEncoder): boolean {
    this.assertReady();
    if (!this.cameraDirty || this.pendingReadback) return false;
    this.session.device.queue.writeBuffer(this.faultsBuffer, 0, ZERO_FAULTS);
    const pass = encoder.beginComputePass({ label: "Deep cluster LOD slot selection" });
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBindGroup);
    pass.dispatchWorkgroups(Math.ceil(this.nodeCount / CLUSTER_LOD_SELECTION_WORKGROUP_SIZE), 1, 1);
    pass.end();
    encoder.copyBufferToBuffer(this.selectionBuffer, 0, this.selectionStaging, 0, this.nodeCount * 4);
    encoder.copyBufferToBuffer(this.faultsBuffer, 0, this.faultsStaging, 0, 4);
    this.pendingReadback = true;
    this.cameraDirty = false;
    return true;
  }

  /** 帧在 encodeFrame 之后、submit 之前失败：读回拷贝从未提交，清挂号并强制下帧重派发。 */
  cancelPendingFrame(): void {
    if (this.disposed) return;
    if (this.pendingReadback) { this.pendingReadback = false; this.cameraDirty = true; }
  }

  /** submit 后异步读回 → 派生 plan → 命令上传；任何异常走 sticky fail-closed，不抛进渲染循环。 */
  async ingest(): Promise<void> {
    if (this.disposed || !this.pendingReadback) return;
    const [selection, faults] = await Promise.all([
      readBackWords(this.selectionStaging, this.nodeCount), readBackWords(this.faultsStaging, 1)]);
    this.pendingReadback = false;
    if (this.disposed) return;
    if (faults[0] !== 0) {
      this.failFallback(`Cluster LOD selection kernel reported ${faults[0]} faults (non-finite screen error).`);
      return;
    }
    try {
      const slots = new Uint32Array(selection);
      const plan = planClusterLodIndirect(this.stagedDag, slots, this.summaries);
      this.execution = this.executor.encode(plan);
      this.drawnTriangles = plan.draws.reduce((sum, draw) => sum + draw.triangleCount, 0);
      this.frontierMaxLevel = plan.draws.reduce((max, draw) => Math.max(max, draw.level), 0);
      this.evidenceSelection = slots;
      this.evidenceFrontier = Object.freeze(plan.draws.map(draw => draw.nodeId));
    } catch (error) {
      this.execution = undefined;
      this.failFallback(`Cluster LOD indirect plan rejected GPU selection: ${(error as Error).message}`);
    }
  }

  /** 主 opaque pass 内执行 bundle；无可用执行（warming/fallback）返回 undefined。 */
  draw(pass: GPURenderPassEncoder): ClusterLodDrawStats | undefined {
    this.assertReady();
    const execution = this.execution;
    if (!execution) return undefined;
    this.executor.execute(pass, execution, this.geometry, this.request);
    return { draws: execution.drawCount, triangles: this.drawnTriangles };
  }

  setViewProjection(viewProjection: ArrayLike<number>): void {
    this.assertReady();
    this.session.device.queue.writeBuffer(this.viewProjectionBuffer, 0, packClusterLodViewProjection(viewProjection));
  }

  /** 帧签名不支持（MRT/directDisplay）时的显式降级记录；sticky，重 stage 才能恢复。 */
  noteFrameSignatureUnsupported(): void {
    this.failFallback("Cluster LOD slot requires the plain HDR opaque pass (no MRT geometry buffers, no direct display).");
  }

  /** sticky fallback 是否已触发；触发后宿主可跳过后续 dispatch。 */
  hasFallback(): boolean {
    return this.fallbackReason !== undefined;
  }

  /** 验收证据：最近一次 ingest 的 GPU 选层槽位（拷贝）与前沿节点 id；尚无读回时 undefined。 */
  lastSelectionEvidence(): { readonly selection: Uint32Array; readonly frontierNodeIds: readonly string[] } | undefined {
    if (this.evidenceSelection === undefined || this.evidenceFrontier === undefined) return undefined;
    return { selection: this.evidenceSelection, frontierNodeIds: this.evidenceFrontier };
  }

  noteIngestFailure(error: unknown): void {
    this.failFallback(`Cluster LOD slot readback failed: ${String(error instanceof Error ? error.message : error)}`);
  }

  metrics(): ClusterLodSlotMetrics {
    const execution = this.execution;
    return { draws: execution?.drawCount ?? 0, triangles: execution ? this.drawnTriangles : 0,
      generation: execution?.generation ?? 0, frontierMaxLevel: this.frontierMaxLevel,
      stale: this.cameraDirty || this.pendingReadback, warming: !execution && this.fallbackReason === undefined,
      ...(this.fallbackReason !== undefined ? { fallbackReason: this.fallbackReason } : {}) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.executor.dispose();
    for (const buffer of this.owned) this.session.release(buffer);
  }

  private failFallback(reason: string): void {
    this.execution = undefined;
    this.fallbackReason ??= reason;
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Cluster LOD render slot is disposed.");
  }

  private own<T extends GPUBuffer>(buffer: T): T { return this.session.own(buffer); }

  private sameCamera(camera: ClusterLodCamera): boolean {
    const last = this.lastCamera;
    return last !== undefined && last.pixelThreshold === camera.pixelThreshold
      && last.viewportHeightPixels === camera.viewportHeightPixels
      && last.tanHalfFovY === camera.tanHalfFovY
      && last.position.every((value, index) => value === camera.position[index])
      && last.forward.every((value, index) => value === camera.forward[index]);
  }
}
