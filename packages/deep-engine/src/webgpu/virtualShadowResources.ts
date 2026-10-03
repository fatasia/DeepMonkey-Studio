import { VIRTUAL_SHADOW_MIP_COUNT, VIRTUAL_SHADOW_PAGE_EDGE, VIRTUAL_SHADOW_TOP_MIP,
  VIRTUAL_SHADOW_VIRTUAL_EDGE, pageViewProjection, planVirtualShadowClipmap,
  type VirtualShadowClipmapPlan } from "../shadows/virtualShadowClipmap.js";
import { VIRTUAL_SHADOW_ATLAS_EDGE, VIRTUAL_SHADOW_ATLAS_LAYERS, VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME,
  VIRTUAL_SHADOW_PHYSICAL_PAGES, type VirtualShadowDynamicInput, type VirtualShadowMaterializeStats,
  type VirtualShadowObjectInput, type VirtualShadowPageTable } from "../shadows/virtualShadowPages.js";
import { packVirtualShadowPageTable } from "./virtualShadowSampling.js";
import type { ShadowVec3 } from "../shadows/types.js";
import { CASCADED_SHADOW_UNIFORM_FLOATS, CASCADED_SHADOW_MAX_CASCADES } from "../shadows/cascadedShadowShader.js";
import type { GodRaysShadowSource } from "../fog/volumetricGodRaysPassTypes.js";
import type { DeviceSession } from "./deviceSession.js";
import { uploadBuffer } from "./meshBuffers.js";
import { PBR_FRAME_FLOAT_OFFSETS, PBR_FRAME_UNIFORM_FLOATS, type Pipelines } from "./pipelines.js";
import { viewProjectionFrustum } from "./pbrFrusta.js";
import type { PacketBuffers } from "./packetBuffers.js";
import { createAdmittedTexture } from "./resourceAdmission.js";

/**
 * B1 Brief-VSM 虚拟阴影 GPU 资源:三环 clipmap 页池 + 页表绑定 + 页物化渲染。
 *
 * - 页池 atlas:r32float 2048² × 4 层(物理页 128²,1024 槽)。depth-as-float 降级
 *   方案:WebGPU 页级写出走 viewport/scissor,depth attachment 无法以页级 viewport
 *   写出后再按普通 f32 采样;页光深因此写 r32float 颜色附件(核心可渲染),
 *   邻页近者胜由共享 depth32float 临时附件承担(无混合依赖,不依赖 float32-filterable);
 * - 页表 binding 3..5(合同见 virtualShadowSampling.ts);binding 0..2 保持级联布局
 *   形态(uniform 同 640B ABI;1/2 用 4×4 占位 depth 资源,虚拟档从不采样它们);
 * - 页物化:每页 = 光空间剔除相位 shadow:<slot>(0..7)+ 页 viewProjection 帧
 *   uniform + 页 viewport/scissor,绘制复用 packets 既有 shadow 通路(页管线变体)。
 */

export const VIRTUAL_SHADOW_PAGE_FRAME_SLOTS = VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME;

export interface VirtualShadowFrameInput {
  readonly eye: ShadowVec3;
  readonly target: ShadowVec3;
  readonly up?: ShadowVec3;
  readonly verticalFovRadians: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly extent: number;
  readonly lightDirection?: ShadowVec3;
  readonly sceneRevision: number;
  readonly objects: readonly VirtualShadowObjectInput[];
  readonly dynamicObjects?: readonly VirtualShadowDynamicInput[];
}

export interface VirtualShadowFramePlan {
  readonly clipmap: VirtualShadowClipmapPlan;
  readonly renderPages: readonly { readonly ring: number; readonly mip: number;
    readonly tileX: number; readonly tileY: number; readonly slot: { readonly layer: number;
      readonly tileX: number; readonly tileY: number; readonly packed: number } }[];
  readonly stats: VirtualShadowMaterializeStats;
  readonly render: boolean;
}

/**
 * 虚拟档 uniform 打包(640B 级联 ABI 空闲槽复用):
 * - matrices[0..2] = 环 viewProjection;splitDepths0[0..2] = 环光深跨度;
 * - texelWorld0[0..2] = 环 texel 世界尺寸,texelWorld0.w = 虚拟边长(采样梯度→mip);
 * - texelWorld1 = (pcssLightWorld, depthBiasNorm, 0, 0);
 * - params2 = (mode=1, ringCount, topMip, pageEdge)。
 */
export function packVirtualShadowUniform(clipmap: VirtualShadowClipmapPlan,
  pcssLightWorld: number, depthBiasNorm: number): Float32Array<ArrayBuffer> {
  const data = new Float32Array(CASCADED_SHADOW_UNIFORM_FLOATS);
  clipmap.rings.forEach((ring, index) => { data.set(ring.viewProjection, index * 16); });
  for (let index = 0; index < CASCADED_SHADOW_MAX_CASCADES; index += 1) {
    const ring = clipmap.rings[index];
    data[128 + index] = ring?.depthSpan ?? 0;
    data[144 + index] = ring?.texelWorldSize ?? 0;
  }
  data[147] = VIRTUAL_SHADOW_VIRTUAL_EDGE;
  data.set([pcssLightWorld, depthBiasNorm, 0, 0], 148);
  data.set([1, clipmap.rings.length, VIRTUAL_SHADOW_TOP_MIP, VIRTUAL_SHADOW_PAGE_EDGE], 156);
  return data;
}

export interface VirtualShadowResourceOptions {
  readonly pcssLightWorld?: number;
  readonly depthBiasNorm?: number;
  readonly frameBudgetMs?: number;
  readonly maxPagesPerFrame?: number;
  /** 页物化成本估算毫秒(页表构造入参;缺省 0.08,真机校准后可覆写)。 */
  readonly perPageCostMs?: number;
}

/** 三环 clipmap 虚拟阴影资源(构造即分配页池;dispose 释放全部托管资源)。 */
export class VirtualShadowResources {
  readonly binding: GPUBindGroup;
  readonly layerViews: readonly GPUTextureView[];
  readonly atlas: GPUTexture;
  readonly frameBindings: readonly GPUBindGroup[];
  private readonly uniform: GPUBuffer;
  private readonly metaBuffer: GPUBuffer;
  private readonly layersBuffer: GPUBuffer;
  private readonly depthAssist: GPUTexture;
  private readonly depthView: GPUTextureView;
  private readonly dummyDepth: GPUTexture;
  private readonly dummyDepthView: GPUTextureView;
  private readonly dummyLayerView: GPUTextureView;
  private readonly sampler: GPUSampler;
  private readonly pageBuffers: readonly GPUBuffer[];
  private readonly createdDevice: GPUDevice;
  private readonly options: Required<VirtualShadowResourceOptions>;
  private lastSignature = "";
  private lastTableEpoch = -1;
  private tableEpoch = 0;
  private frameCounter = 0;
  private renderingEnabled = true;
  private disposed = false;

  constructor(private readonly session: DeviceSession, pipelines: Pipelines,
    readonly table: VirtualShadowPageTable, options: VirtualShadowResourceOptions = {}) {
    this.options = { pcssLightWorld: options.pcssLightWorld ?? 0,
      depthBiasNorm: options.depthBiasNorm ?? 0.0012,
      frameBudgetMs: options.frameBudgetMs ?? 2.5,
      maxPagesPerFrame: options.maxPagesPerFrame ?? VIRTUAL_SHADOW_MAX_PAGES_PER_FRAME,
      perPageCostMs: options.perPageCostMs ?? 0.08 };
    const device = session.device;
    this.createdDevice = device;
    const created: Array<GPUTexture | GPUBuffer> = [];
    try {
      const atlas = createAdmittedTexture(session, {
        label: "Deep virtual shadow page atlas",
        size: [VIRTUAL_SHADOW_ATLAS_EDGE, VIRTUAL_SHADOW_ATLAS_EDGE, VIRTUAL_SHADOW_ATLAS_LAYERS],
        // COPY_SRC:联测诊断可读回页内容(验收证据用;产品帧零 readback)。
        format: "r32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
      created.push(atlas);
      const layerViews = Object.freeze(Array.from({ length: VIRTUAL_SHADOW_ATLAS_LAYERS },
        (_, baseArrayLayer) => atlas.createView({ dimension: "2d", baseArrayLayer, arrayLayerCount: 1 })));
      const depthAssist = createAdmittedTexture(session, {
        label: "Deep virtual shadow page depth assist",
        size: [VIRTUAL_SHADOW_ATLAS_EDGE, VIRTUAL_SHADOW_ATLAS_EDGE, 1],
        format: "depth32float", usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      created.push(depthAssist);
      const dummyDepth = createAdmittedTexture(session, {
        label: "Deep virtual shadow cascade placeholder",
        size: [4, 4, 1], format: "depth32float",
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
      created.push(dummyDepth);
      const uniform = uploadBuffer(session, "Deep virtual shadow uniform",
        new Float32Array(CASCADED_SHADOW_UNIFORM_FLOATS), GPUBufferUsage.UNIFORM);
      created.push(uniform);
      const emptyPacking = packVirtualShadowPageTable(3, () => undefined);
      const storageUsage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      const metaBuffer = device.createBuffer({ label: "Deep virtual shadow page meta",
        size: emptyPacking.meta.byteLength, usage: storageUsage });
      const layersBuffer = device.createBuffer({ label: "Deep virtual shadow page layers",
        size: emptyPacking.layers.byteLength, usage: storageUsage });
      created.push(metaBuffer, layersBuffer);
      const pageBuffers: GPUBuffer[] = [];
      for (let slot = 0; slot < VIRTUAL_SHADOW_PAGE_FRAME_SLOTS; slot++) {
        const buffer = uploadBuffer(session, `Deep virtual shadow page ${slot} frame`,
          new Float32Array(PBR_FRAME_UNIFORM_FLOATS), GPUBufferUsage.UNIFORM);
        created.push(buffer); pageBuffers.push(buffer);
      }
      const shadowFrameLayout = pipelines.shadow.getBindGroupLayout(0);
      const frameBindings = Object.freeze(pageBuffers.map(buffer => device.createBindGroup({
        layout: shadowFrameLayout, entries: [{ binding: 0, resource: { buffer } }] })));
      this.atlas = atlas; this.layerViews = layerViews; this.depthAssist = depthAssist;
      this.depthView = depthAssist.createView();
      this.dummyDepth = dummyDepth;
      this.dummyDepthView = dummyDepth.createView({ dimension: "2d-array" });
      this.dummyLayerView = dummyDepth.createView({ dimension: "2d", aspect: "depth-only" });
      this.sampler = device.createSampler({ compare: "less-equal", minFilter: "linear", magFilter: "linear" });
      this.uniform = uniform; this.metaBuffer = metaBuffer; this.layersBuffer = layersBuffer;
      this.pageBuffers = Object.freeze(pageBuffers); this.frameBindings = frameBindings;
      this.binding = device.createBindGroup({ layout: pipelines.cascadedShadowLayout, entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: this.dummyDepthView },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: { buffer: metaBuffer } },
        { binding: 4, resource: { buffer: layersBuffer } },
        { binding: 5, resource: atlas.createView({ dimension: "2d-array" }) },
      ] });
    } catch (error) {
      for (const resource of created.reverse()) session.release(resource);
      throw error;
    }
  }

  /** 逐帧规划:clipmap → 动态失效 → Top-K 物化;签名驱动 uniform,版本驱动页表上传。 */
  prepare(input: VirtualShadowFrameInput, force: boolean, enabled = true): VirtualShadowFramePlan {
    if (this.disposed) throw new Error("Virtual shadow resources are disposed.");
    if (enabled && !this.renderingEnabled) this.invalidate();
    this.renderingEnabled = enabled;
    const clipmap = planVirtualShadowClipmap({
      eye: input.eye, target: input.target, ...(input.up ? { up: input.up } : {}),
      verticalFovRadians: input.verticalFovRadians, aspect: input.aspect,
      near: input.near, far: input.far, extent: input.extent,
    }, input.lightDirection ?? [-1.6, -2.8, -1.2]);
    const signature = `${clipmap.rings.map(ring => ring.halfExtent).join(",")}:`
      + `${clipmap.lightDirection.map(value => value.toFixed(6)).join(",")}`;
    if (signature !== this.lastSignature || force) {
      this.session.device.queue.writeBuffer(this.uniform, 0,
        packVirtualShadowUniform(clipmap, this.options.pcssLightWorld, this.options.depthBiasNorm));
      this.lastSignature = signature;
    }
    if (input.dynamicObjects?.length && this.renderingEnabled) {
      this.table.invalidateDynamic(input.dynamicObjects, clipmap);
    }
    const frame = this.frameCounter;
    this.frameCounter += 1;
    const materialized = this.table.plan(clipmap, this.renderingEnabled ? input.objects : [],
      frame, Math.max(0, Math.floor(input.sceneRevision)),
      { frameBudgetMs: this.options.frameBudgetMs, maxPagesPerFrame: this.options.maxPagesPerFrame });
    if (materialized.stats.materializedPages > 0 || materialized.stats.evictedPages > 0) {
      this.markTableChanged();
    }
    if (this.tableEpoch !== this.lastTableEpoch) {
      // layers 值 = 打包物理 slot(layer·256 + slotY·16 + slotX);slot 的 atlas tile
      // (0..15)与页表虚拟 tile(0..127)是两个坐标,必须取 slot 内的物理 tile。
      const packing = packVirtualShadowPageTable(clipmap.rings.length, (ring, mip, tileX, tileY) =>
        this.table.slotOf(`r${ring}|m${mip}|${tileX}|${tileY}`)?.packed);
      this.session.device.queue.writeBuffer(this.metaBuffer, 0, packing.meta);
      this.session.device.queue.writeBuffer(this.layersBuffer, 0, packing.layers);
      this.lastTableEpoch = this.tableEpoch;
    }
    return { clipmap,
      renderPages: materialized.renderPages.map(page => ({ ring: page.ring, mip: page.mip,
        tileX: page.tileX, tileY: page.tileY, slot: page.slot })),
      stats: materialized.stats, render: this.renderingEnabled && materialized.renderPages.length > 0 };
  }

  /** 页表驻留变化后置脏(prepare 内部自动调用;诊断/外部失效用)。 */
  markTableChanged(): void { this.tableEpoch += 1; }

  /**
   * 页物化渲染:先按页槽(0..7)编码光空间剔除(packetBuffers 合同:剔除先于渲染
   * pass),再每物理层一个 render pass,页间 viewport/scissor 切换;绘制复用 packets
   * 既有 shadow 通路(页管线变体)。首 pass 携带 timingStart(与级联 index 0 同形)。
   */
  encodePages(encoder: GPUCommandEncoder, packets: PacketBuffers, pagePipelines: Pipelines,
    plan: VirtualShadowFramePlan,
    timingStart?: { timestampWrites?: { querySet: GPUQuerySet; beginningOfPassWriteIndex: number } }):
      { drawCalls: number; triangles: number; passes: number } {
    if (this.disposed) throw new Error("Virtual shadow resources are disposed.");
    const pages = plan.renderPages;
    if (pages.length === 0) return { drawCalls: 0, triangles: 0, passes: 0 };
    const pageSlots = pages.map((page, slot) => ({ page, slot,
      viewProjection: pageViewProjection(plan.clipmap.rings[page.ring]!, page.mip, page.tileX, page.tileY,
        plan.clipmap.lightDirection) }));
    pageSlots.forEach(({ viewProjection }, slot) => {
      const data = new Float32Array(PBR_FRAME_UNIFORM_FLOATS);
      data.set(viewProjection, PBR_FRAME_FLOAT_OFFSETS.lightViewProjection);
      this.session.device.queue.writeBuffer(this.pageBuffers[slot]!, 0, data);
    });
    for (const entry of pageSlots) {
      packets.encodeCulling(encoder, viewProjectionFrustum(entry.viewProjection), "shadow", undefined, entry.slot);
    }
    let drawCalls = 0, triangles = 0, firstPass = true;
    const byLayer = new Map<number, typeof pageSlots>();
    for (const entry of pageSlots) {
      const list = byLayer.get(entry.page.slot.layer) ?? [];
      list.push(entry);
      byLayer.set(entry.page.slot.layer, list);
    }
    for (const [layer, layerPages] of [...byLayer.entries()].sort(([a], [b]) => a - b)) {
      const pass = encoder.beginRenderPass({
        label: `Deep virtual shadow pages layer ${layer}`,
        ...(firstPass && timingStart?.timestampWrites ? timingStart : {}),
        colorAttachments: [{ view: this.layerViews[layer]!, loadOp: "clear", storeOp: "store",
          clearValue: { r: 1, g: 1, b: 1, a: 1 } }],
        depthStencilAttachment: { view: this.depthView, depthClearValue: 1,
          depthLoadOp: "clear", depthStoreOp: "store" },
      });
      for (const entry of layerPages) {
        pass.setViewport(entry.page.slot.tileX * VIRTUAL_SHADOW_PAGE_EDGE,
          entry.page.slot.tileY * VIRTUAL_SHADOW_PAGE_EDGE,
          VIRTUAL_SHADOW_PAGE_EDGE, VIRTUAL_SHADOW_PAGE_EDGE, 0, 1);
        pass.setScissorRect(entry.page.slot.tileX * VIRTUAL_SHADOW_PAGE_EDGE,
          entry.page.slot.tileY * VIRTUAL_SHADOW_PAGE_EDGE,
          VIRTUAL_SHADOW_PAGE_EDGE, VIRTUAL_SHADOW_PAGE_EDGE);
        pass.setBindGroup(0, this.frameBindings[entry.slot]!);
        const stats = packets.draw(pass, pagePipelines, "shadow", undefined, true, entry.slot, false, false);
        drawCalls += stats.drawCalls; triangles += stats.triangles;
      }
      pass.end();
      firstPass = false;
    }
    return { drawCalls, triangles, passes: byLayer.size };
  }

  /** 虚拟档遥测:页池几何(shadowMode 供 FrameMetrics 顶层面)。 */
  get metrics() {
    return {
      shadowMode: "virtual" as const,
      virtualShadowPages: {
        residentPages: this.table.residentCount,
        allocatedSlots: VIRTUAL_SHADOW_PHYSICAL_PAGES - this.table.freeSlotCount,
        physicalPages: VIRTUAL_SHADOW_PHYSICAL_PAGES,
        atlasEdge: VIRTUAL_SHADOW_ATLAS_EDGE, atlasLayers: VIRTUAL_SHADOW_ATLAS_LAYERS,
        pageEdge: VIRTUAL_SHADOW_PAGE_EDGE, mipCount: VIRTUAL_SHADOW_MIP_COUNT,
      },
    };
  }

  /** 体积雾 god rays 在虚拟档 fail-closed(enabled=false),不消费空级联数组。 */
  godRaysSource(): GodRaysShadowSource {
    if (this.disposed) throw new Error("Virtual shadow resources are disposed.");
    if (this.session.device !== this.createdDevice) throw new Error("Virtual shadow resources belong to a previous device.");
    return { uniform: this.uniform, view: this.dummyDepthView, sampler: this.sampler, enabled: false };
  }

  /** 虚拟档 directDisplay 快路径不可用(单级联 legacy 视图语义),返回占位 depth 视图。 */
  get legacyView(): GPUTextureView { return this.dummyLayerView; }

  commit(): void { /* 页表 epoch 在 prepare 侧推进;保留提交点(与 CSM 生命周期合同对齐)。 */ }

  invalidate(): void {
    this.table.invalidate();
    this.lastSignature = "";
    this.lastTableEpoch = -1;
    this.markTableChanged();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.release(this.atlas);
    this.session.release(this.depthAssist);
    this.session.release(this.dummyDepth);
    this.session.release(this.uniform);
    this.session.release(this.metaBuffer);
    this.session.release(this.layersBuffer);
    for (const buffer of this.pageBuffers) this.session.release(buffer);
    this.table.dispose();
  }
}
