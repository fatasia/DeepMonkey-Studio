/// <reference types="@webgpu/types" />
/**
 * F3 探针网格 GPU 烘焙编排服务：闭环"捕获 → 读回 → 网格聚合 → 编译器输入"的生产者链。
 * 数值核心（网格计划/读回解码/聚合）全部在 probeGridBakeMath.ts 纯函数内，本模块只做
 * GPU 样本供给编排：
 * - 内部复用既有 `ProbeSceneRadianceProducer`（一跳场景辐射捕获 encodeSourceRadiance）
 *   对整个网格一次性 dispatch 捕获；
 * - 捕获纹理按 probeGridReadbackLayout 读回（模式与 webgpu/environmentAmbientReader
 *   同款：storage 纹理 → COPY_SRC → MAP_READ），decodeProbeGridCapture 解码成样本表；
 * - aggregateProbeGridBake 装配出与 apps/web `compileSceneRuntimePackage`
 *   options.irradianceProbes 单层 SceneIrradianceProbeGridBake 结构兼容的对象；
 * - bake 收尾用 Native 打包器（packNativeProbeGridRecords，即编译器写包前调用的同一
 *   校验器）对输出做编译器输入路径的 fail-closed 对账，保证产出一定能过编译器输入关口。
 *
 * == 诚实边界 ==
 * 一跳直射+环境估计（命中点不追第二次阴影射线）；环境 ambient 项由宿主馈送（可来自
 * EnvironmentAmbientReader 的真实 GPU 读回），无真实辐射源时 producer 既有 fail-closed
 * 合同拒绝烘焙（保持 IBL，禁止发布黑色体积）。
 */

import type { RenderPacket } from "../renderPacket.js";
import { packNativeProbeGridRecords } from "../lighting/nativeProbeGridPacker.js";
import { runResourceCleanup } from "../webgpu/resourceCleanup.js";
import {
  ProbeSceneRadianceProducer, type ProbeRadianceLighting, type ProbeSceneRadianceBatchStats,
} from "./probeSceneRadianceProducer.js";
import {
  aggregateProbeGridBake, decodeProbeGridCapture, planProbeGridCapture, probeGridReadbackLayout,
  type ProbeGridBake, type ProbeGridBakeGrid, type ProbeGridCaptureSample,
} from "./probeGridBakeMath.js";

export type { ProbeGridBake, ProbeGridBakeGrid, ProbeGridCaptureSample };

export interface ProbeGridBakeServiceOptions {
  /** 烘焙辐射源（主直射光 + 环境项）；无真实辐射源时既有 fail-closed 合同拒绝烘焙。 */
  readonly lighting: ProbeRadianceLighting;
  /** 透传 producer：每探针方向数（1..16），默认 8。 */
  readonly directionCount?: number;
  /** 透传 producer：射线最大行程（世界单位），默认 32。 */
  readonly maxDistance?: number;
}

export interface ProbeGridBakeEvidence {
  readonly bake: ProbeGridBake;
  readonly probeCount: number;
  /** 捕获覆盖的 cell 数（validity 1 的条目数）。 */
  readonly coveredCount: number;
  /** 两级遍历溢出哨兵（0 = 全部遍历完成；非 0 已在 bake 内 fail-closed 抛错）。 */
  readonly overflowSentinel: 0;
  readonly directionCount: number;
  readonly maxDistance: number;
  readonly sceneInstances: number;
}

/**
 * GPU 烘焙编排：输入场景辐射源（RenderPacket）+ 网格参数 → SceneIrradianceProbeBake
 * 兼容对象。GPU 只做样本供给；数值聚合、覆盖判定、输出装配全部走纯函数。
 */
export class ProbeGridBakeService {
  private readonly device: GPUDevice;
  private readonly producer: ProbeSceneRadianceProducer;
  private readonly lighting: ProbeRadianceLighting;
  private generation = 0;
  private disposed = false;

  constructor(device: GPUDevice, options: ProbeGridBakeServiceOptions) {
    this.device = device;
    this.lighting = options.lighting;
    // 构造即建 producer 并锁存 lighting：光向量非法（非有限通道/负强度）在此 fail-fast
    // （复用 producer 既有 validateLighting 合同）；零能量辐射源由 encodeSourceRadiance
    // 在 bake 捕获编码时按既有合同拒绝，不重复实现。
    this.producer = new ProbeSceneRadianceProducer(device, {
      ...(options.directionCount === undefined ? {} : { directionCount: options.directionCount }),
      ...(options.maxDistance === undefined ? {} : { maxDistance: options.maxDistance }),
    });
    this.producer.syncLighting(this.lighting);
  }

  /** 最近一次捕获批次统计（证据透传）。 */
  get lastBatchStats(): ProbeSceneRadianceBatchStats | undefined { return this.producer.lastBatchStats; }
  get disposedFlag(): boolean { return this.disposed; }

  /**
   * 一次单层网格烘焙。同一服务可多次 bake（场景按 packet 身份去重上传；generation
   * 递增绕过 encodeSourceRadiance 的同代幂等，保证重跑真的重新捕获——真机确定性
   * 取证依赖这一点）。失败路径 fail-closed：场景不可用/无辐射源/溢出哨兵非 0 一律
   * 抛错且不产出 bake。
   */
  async bake(packet: RenderPacket, grid: ProbeGridBakeGrid): Promise<ProbeGridBakeEvidence> {
    if (this.disposed) throw new Error("Probe grid bake service is disposed.");
    const plan = planProbeGridCapture(grid);
    // 场景上传（无效 packet 在此抛错，与 producer 既有合同一致）。
    this.producer.syncScene(packet);
    this.producer.syncLighting(this.lighting);
    const generation = ++this.generation;

    // 捕获纹理：单层 2d-array，texel=(x,y)、layer=z（与 probeRadianceKernel 布局合同一致）。
    const capture = this.device.createTexture({ label: "probe grid bake capture",
      size: { width: plan.width, height: plan.height, depthOrArrayLayers: plan.layers },
      dimension: "2d", mipLevelCount: 1, format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING });
    const view = capture.createView({ dimension: "2d-array", baseMipLevel: 0, mipLevelCount: 1,
      baseArrayLayer: 0, arrayLayerCount: plan.layers });
    const layout = probeGridReadbackLayout(plan.width, plan.height, plan.layers);
    const readback = this.device.createBuffer({ label: "probe grid bake capture readback",
      size: layout.bytesPerRow * layout.rowsPerImage * layout.layers,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const overflowReadback = this.device.createBuffer({ label: "probe grid bake overflow readback",
      size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder({ label: "probe grid bake capture" });
      // encodeSourceRadiance 只消费 plan.profile.gridSize 与 updates（层布局/texel 映射）；
      // 最小上下文断言为该窄合同（与 lab 真机取证探针同款）。
      const first = plan.updates[0]!;
      this.producer.encodeSourceRadiance({
        encoder, update: first as never, updateIndex: 0,
        destination: capture, destinationView: view, destinationOrigin: { x: 0, y: 0, z: 0 },
        context: { generation, deviceEpoch: "probe-grid-bake", plan: {
          profile: { gridSize: [...grid.gridSize] }, updates: plan.updates,
        }, signal: new AbortController().signal, resource: {} } as never,
      } as never);
      encoder.copyTextureToBuffer({ texture: capture }, {
        buffer: readback, bytesPerRow: layout.bytesPerRow, rowsPerImage: layout.rowsPerImage,
      }, { width: plan.width, height: plan.height, depthOrArrayLayers: plan.layers });
      encoder.copyBufferToBuffer(this.producer.overflowEvidenceBuffer, 0, overflowReadback, 0, 4);
      this.device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const samples = decodeProbeGridCapture(
        new Uint16Array(readback.getMappedRange().slice(0)), layout);
      readback.unmap();
      await overflowReadback.mapAsync(GPUMapMode.READ);
      const overflowSentinel = new Uint32Array(overflowReadback.getMappedRange().slice(0))[0]!;
      overflowReadback.unmap();
      // 溢出 = 该批次遍历未全部完成，对应 texel 已被内核清零：fail-closed 拒绝烘焙，
      // 不发布带 validity 0 洞的半成品（调用方可缩网格或加预算后重试）。
      if (overflowSentinel !== 0) {
        throw new Error(`probe-grid-bake: stack overflow sentinel ${overflowSentinel}; refuse to publish.`);
      }
      const bake = aggregateProbeGridBake(grid, samples);
      // 编译器输入路径的同一校验（compileSceneRuntimePackage 写包前调用的就是本打包器）：
      // 产出必须先过这道 fail-closed 关口才返回给调用方。
      packNativeProbeGridRecords({ origin: bake.origin, spacing: bake.spacing, gridSize: bake.gridSize },
        bake.probes);
      return { bake,
        probeCount: plan.probeCount,
        coveredCount: samples.reduce((sum, sample) => sum + (sample.covered ? 1 : 0), 0),
        overflowSentinel: 0,
        directionCount: this.producer.lastBatchStats?.directionCount ?? 0,
        maxDistance: this.producer.lastBatchStats?.maxDistance ?? 0,
        sceneInstances: this.producer.lastBatchStats?.sceneInstances ?? 0 };
    } finally {
      runResourceCleanup("Probe grid bake evidence cleanup failed.", [
        () => readback.destroy(), () => overflowReadback.destroy(), () => capture.destroy()]);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.producer.dispose();
  }
}
