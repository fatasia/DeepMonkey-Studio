/**
 * B4 簇级隐藏收益对照(CPU 层,可证伪;GPU 帧时不在本测试范围)。
 *
 * 同一合成场景(200 几何 × 10 实例 = 2000 实例、200 个编目块),同一机位序列,
 * 分别以"簇隐藏关"与"簇隐藏开"(真实 HlodClusterDecisionEngine 决策链)驱动
 * AuthorChunkStream,对照:
 *   - 投影批数(staged projection batches ≈ draw 编译数)
 *   - 驻留 GPU 字节(steady state,residency telemetry)
 *   - 全量同步/相机同步耗时(CPU 编译+规划,mocked GPU,不代表真机帧时)
 * 证据写 test-output/deep-core/B4-cluster-stream/benchmark.json。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket, RenderInstance } from "../renderPacket.js";
import type { RenderView } from "../webgpu/pbrRendererTypes.js";
import { chunkGpuFixture } from "../webgpu/sceneChunkResidency.testUtils.js";
import { PacketBuffers } from "../webgpu/packetBuffers.js";
import type { ResidentPacketProjection } from "../webgpu/residentPacketProjection.js";
import { HLOD_PROXY_MATERIAL_ID, HlodClusterDecisionEngine,
  type HlodClusterStreamBinding } from "./hlodClusterStream.js";
import { AuthorChunkStream } from "./authorChunkStream.js";
import { buildTestHlodPackage } from "./hlodClusterStream.testUtils.js";

const CLUSTER_COUNT = 200, PER_CLUSTER = 10;
const INSTANCES: RenderInstance[] = Array.from({ length: CLUSTER_COUNT * PER_CLUSTER }, (_, index) => ({
  id: `inst-${index}`, geometry: `bench-mesh-${index % CLUSTER_COUNT}`, material: "mat",
  transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (index % CLUSTER_COUNT) * 2, Math.floor(index / CLUSTER_COUNT) * 2, 0, 1],
}));
// 包级构建一次:manifest + 内容寻址代理几何(与编译层同约定,随包分发)。
const PKG = buildTestHlodPackage(INSTANCES.map(instance => ({ id: instance.id,
  position: [instance.transform[12]!, instance.transform[13]!, instance.transform[14]!] as [number, number, number],
  radius: 1 })));
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function benchPacket(): RenderPacket {
  return { geometries: [...Array.from({ length: CLUSTER_COUNT }, (_, index) => ({
      id: `bench-mesh-${index}`, revision: 1,
      vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]) })), ...PKG.geometries],
    materials: [{ id: "mat", baseColor: [0.8, 0.8, 0.82], metallic: 0, roughness: 1 },
      { id: HLOD_PROXY_MATERIAL_ID, baseColor: [0.55, 0.55, 0.58], metallic: 0, roughness: 1 }],
    instances: INSTANCES };
}
function clusterBinding(): HlodClusterStreamBinding {
  return { manifest: PKG.manifest,
    instanceIdsByNode: new Map(PKG.manifest.nodes.filter(node => node.children.length === 0)
      .flatMap(node => node.instanceIds).map(apiId => [apiId, [apiId]])),
    proxyDrawsByNode: new Map(PKG.manifest.proxies.map(proxy => [proxy.nodeId,
      [{ instanceId: `px-${proxy.nodeId}`, geometryId: proxy.geometryId, transform: IDENTITY }]])),
    decisionFromWorld: IDENTITY };
}
// 远机位:depth 4000 → root(半径≈202)屏幕误差 ≈6px < 8 折叠;extent 300 → far 6000 保持块在视锥内。
const view: RenderView = { width: 100, height: 100, pixelRatio: 1, eye: [200, 10, 4000], target: [200, 10, 0],
  extent: 300, background: [0, 0, 0], floor: [0, 0, 0], exposure: 1, roughness: 0.5 };

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8, STORAGE: 128, UNIFORM: 64 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => vi.unstubAllGlobals());

interface Measurement {
  readonly mode: "off" | "on";
  readonly projectedBatches: number;
  readonly visibleChunks: number;
  readonly prefetchChunks: number;
  readonly residentGpuBytes: number;
  readonly fullSyncMs: number;
  readonly viewSyncMs: number;
  readonly hlodHiddenInstances?: number;
  readonly hlodActiveProxies?: number;
  readonly hlodCollapsedNodes?: number;
}

async function measure(mode: "off" | "on"): Promise<Measurement> {
  const f = chunkGpuFixture();
  Object.assign(f.session.device, { createBindGroup: vi.fn(() => ({})) });
  const buffers = new PacketBuffers(f.session, { material: {} as GPUBindGroupLayout });
  let projectedBatches = 0;
  const target = { session: f.session,
    stageResidentPacketValidated: vi.fn(async (projection: ResidentPacketProjection, signal?: AbortSignal) => {
      projectedBatches = projection.batches.length;
      await buffers.stageResidentProjectionValidated(projection, signal);
    }), cancelResidentPacketStage: vi.fn(() => buffers.cancelPendingPacketStage()) };
  const packetValue = benchPacket();
  const stream = new AuthorChunkStream(target, false, mode === "on"
    ? { geometries: new Map(PKG.geometries.map(geometry => [geometry.id, geometry])),
        materials: packetValue.materials } : undefined);
  const engine = mode === "on" ? new HlodClusterDecisionEngine([clusterBinding()]) : undefined;
  try {
    const fullStart = performance.now();
    await stream.sync(packetValue, true, view, undefined, engine?.decide(view, [0, 0, 0]));
    const fullSyncMs = performance.now() - fullStart;
    // 迁移帧(代理上传+原块延迟逐出)之后补一帧纯逐出,进入稳态再计量。
    const transitionStart = performance.now();
    await stream.syncView(view, undefined, engine?.decide(view, [0, 0, 0]));
    const steadyStart = performance.now();
    await stream.syncView(view, undefined, engine?.decide(view, [0, 0, 0]));
    const viewSyncMs = (performance.now() - transitionStart) + (performance.now() - steadyStart);
    const diagnostics = stream.diagnostics;
    return { mode, projectedBatches, visibleChunks: diagnostics.visibleChunks,
      prefetchChunks: diagnostics.prefetchChunks, residentGpuBytes: diagnostics.residentGpuBytes,
      fullSyncMs, viewSyncMs,
      ...(diagnostics.hlodHiddenInstances === undefined ? {} : {
        hlodHiddenInstances: diagnostics.hlodHiddenInstances,
        hlodActiveProxies: diagnostics.hlodActiveProxies,
        hlodCollapsedNodes: diagnostics.hlodCollapsedNodes }) };
  } finally {
    stream.dispose(); buffers.dispose();
    expect(f.owned.size).toBe(0);
  }
}

describe("B4 cluster culling CPU benchmark", () => {
  it("compares draw projection, residency and CPU sync time with clusters off vs on", async () => {
    const off = await measure("off"), on = await measure("on");
    expect(on.hlodHiddenInstances).toBe(CLUSTER_COUNT * PER_CLUSTER);
    expect(on.hlodCollapsedNodes).toBeGreaterThan(0);
    expect(on.hlodActiveProxies).toBeGreaterThan(0);
    console.log("DBG-OFF", JSON.stringify(off));
    console.log("DBG-ON", JSON.stringify(on));
    const evidence = { generatedAt: new Date().toISOString(), scene: {
      instances: CLUSTER_COUNT * PER_CLUSTER, chunks: CLUSTER_COUNT,
      proxyNodes: PKG.manifest.proxies.length,
      note: "合成场景;GPU 为 mocked 设备,耗时仅覆盖 CPU 编译+规划,不代表真机帧时" },
      off, on,
      drawReduction: off.projectedBatches === 0 ? null
        : Number((1 - on.projectedBatches / off.projectedBatches).toFixed(4)),
      residencyReduction: off.residentGpuBytes === 0 ? null
        : Number((1 - on.residentGpuBytes / off.residentGpuBytes).toFixed(4)) };
    const outDir = join(process.cwd(), "..", "..", "test-output", "deep-core", "B4-cluster-stream");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "benchmark.json"), JSON.stringify(evidence, null, 2), { encoding: "utf-8" });
    console.log("B4-BENCH", JSON.stringify(evidence));
  }, 120_000);
});
