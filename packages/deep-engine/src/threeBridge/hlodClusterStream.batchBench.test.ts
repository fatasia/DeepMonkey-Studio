/**
 * B4/HLOD GPU 绘制整合收益对照(T00 车间 10k 档;CPU 层,可证伪)。
 *
 * 同一决策计划(`decideHlodFrame` @ targetPixelError 8 + 迟滞 0.12,真实 GLB 包围),
 * 对照两条代理绘制路径:
 * - 逐代理(现状,authorChunkStream.applyClusterPlan 的 overlay 块合同):
 *   1 活动代理 = 1 块 + 1 批 + 1 draw;激活上传几何 + 144B 批行;每应用帧 144B×N 批重铺;
 *   CPU 计量 = 逐代理包构造 + 材质线性查找 + 批行分配(authorChunkStream.proxyPacket 的计划层镜像)。
 * - 合批(本切片,hlodProxyDrawBatch):单元盒几何 ×1 + 每代理 64B 实例行 = 1 实例化 draw;
 *   脏行 delta 只重编变化行。
 *
 * 诚实边界:GPU 为无(mocked 无设备),所有耗时是 CPU 计划层;真机 GPU 帧时/逐 pass
 * 计时(gpu-pass:hlod-proxy)unmeasured,联测清单见证据 JSON 的 realGpuChecklist。
 * 证据写 test-output/deep-core/B4-gpu-draw/batch-benchmark.json。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHlodTree, type HlodClusterTree } from "../hlod/hlodCluster.js";
import { decideHlodFrame, type HlodFrameDecision } from "../hlod/hlodDecision.js";
import { generateHlodProxiesForFrame } from "../hlod/hlodProxyBatch.js";
import { workshopCameraAt, workshopHlodFixture, workshopSceneSphere,
  type WorkshopHlodFixture } from "../hlod/hlodWorkshopFixture.testUtils.js";
import type { GeometryResource } from "../renderPacket.js";
import { composeProxyInstanceMatrix, hlodProxyBoxExtents, hlodProxyDrawCost,
  hlodProxyUnitBoxGeometry, HLOD_PROXY_UNIT_GEOMETRY_ID, HlodProxyDrawBatcher,
  PER_PROXY_BATCH_ROW_BYTES } from "../webgpu/hlodProxyDrawBatch.js";
import { HLOD_PROXY_MATERIAL_ID, type HlodClusterFramePlan,
  type HlodClusterProxyDraw } from "./hlodClusterStream.js";

const TIER = 10_000;
const CAMERAS = [["近 0.25×", 0.25], ["巡航 1×", 1], ["远 4×", 4], ["航拍 64×", 64]] as const;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const MATERIALS = [{ id: HLOD_PROXY_MATERIAL_ID, baseColor: [0.55, 0.55, 0.58] as const,
  metallic: 0, roughness: 1 }];

interface CameraMeasurement {
  readonly label: string;
  readonly hiddenInstances: number;
  readonly activeProxies: number;
  readonly perProxyDraws: number;
  readonly batchedDraws: number;
  readonly drawReduction: number;
  readonly proxyGeometryBytes: number;
  readonly perProxyActivationBytes: number;
  readonly batchedActivationBytes: number;
  readonly perProxyPlanMs: number;
  readonly batchedColdPlanMs: number;
  readonly batchedWarmPlanMs: number;
  readonly batchedSteadyChangedRows: number;
}

/** 决策帧 → 渲染计划 + 该帧折叠集的代理几何(生产口径:generateHlodProxiesForFrame)。 */
function framePlan(tree: HlodClusterTree, fixture: WorkshopHlodFixture,
  decision: HlodFrameDecision): { readonly plan: HlodClusterFramePlan;
  readonly geometries: Map<string, GeometryResource> } {
  const batch = generateHlodProxiesForFrame(tree, fixture.shapes, decision);
  const geometries = new Map<string, GeometryResource>(batch.entries.map(entry => [entry.geometryId, {
    id: entry.geometryId, revision: 0, vertices: entry.proxy.mesh.vertices,
    indices: entry.proxy.mesh.indices }]));
  const geometryIdByNode = new Map(batch.entries.map(entry => [entry.nodeId, entry.geometryId]));
  const hidden = new Set<string>();
  const draws: HlodClusterProxyDraw[] = [];
  for (const node of decision.collapsedNodes) {
    const geometryId = geometryIdByNode.get(node.nodeId);
    if (!geometryId) throw new Error(`proxy geometry missing for ${node.nodeId}`);
    const members = tree.nodes.get(node.nodeId)?.instanceIds ?? [];
    if (members.length === 0) throw new Error(`HLOD collapsed node ${node.nodeId} has no tree members.`);
    for (const apiId of members) hidden.add(apiId);
    draws.push({ instanceId: `px-${node.nodeId}`, geometryId, transform: [...IDENTITY] });
  }
  return { plan: { origin: [0, 0, 0], hiddenInstanceIds: hidden,
      activeProxyDraws: new Map(draws.map(draw => [draw.instanceId, draw])),
      collapsedNodeCount: decision.collapsedNodes.length, suppressed: false }, geometries };
}

/** 逐代理路径的计划层镜像(每活动代理:包构造 + 材质线性查找 + 144B 批行)。 */
function perProxyApplication(plan: HlodClusterFramePlan,
  geometries: ReadonlyMap<string, GeometryResource>): number {
  let batchBytes = 0;
  for (const draw of plan.activeProxyDraws.values()) {
    const geometry = geometries.get(draw.geometryId);
    if (!geometry) throw new Error(`HLOD proxy geometry is not distributed in the packet: ${draw.geometryId}`);
    if (!MATERIALS.some(candidate => candidate.id === HLOD_PROXY_MATERIAL_ID)) {
      throw new Error("HLOD proxy material missing.");
    }
    const row = new Float32Array(PER_PROXY_BATCH_ROW_BYTES / 4);
    row.set(Array.from(draw.transform).slice(0, 16));
    batchBytes += geometry.vertices.byteLength + geometry.indices.byteLength + PER_PROXY_BATCH_ROW_BYTES;
  }
  return batchBytes;
}

function medianOf(fn: () => void, iterations: number): number {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  return Number(samples.sort((left, right) => left - right)[Math.floor(iterations / 2)]!.toFixed(4));
}

describe("B4 HLOD proxy draw batching benchmark (T00 workshop 10k)", () => {
  it("compares per-proxy vs batched proxy draw plans across the camera ladder", async () => {
    const fixture = await workshopHlodFixture(TIER);
    expect(fixture.instances.length).toBe(TIER);
    const tree = buildHlodTree(fixture.instances, { maxChildren: 8 });
    const sphere = workshopSceneSphere(fixture.instances);
    const unitGeometry = hlodProxyUnitBoxGeometry();
    const unitBytes = unitGeometry.vertices.byteLength + unitGeometry.indices.byteLength;
    const measurements: CameraMeasurement[] = [];
    let farPlan: ReturnType<typeof framePlan> | undefined;

    for (const [label, scale] of CAMERAS) {
      const decision = decideHlodFrame(tree, workshopCameraAt(sphere, scale));
      const { plan, geometries } = framePlan(tree, fixture, decision);
      if (label === "远 4×") farPlan = { plan, geometries };
      const activeProxies = plan.activeProxyDraws.size;
      expect(activeProxies).toBeGreaterThan(0);
      const proxyGeometryBytes = [...plan.activeProxyDraws.values()].reduce((sum, draw) => {
        const geometry = geometries.get(draw.geometryId)!;
        return sum + geometry.vertices.byteLength + geometry.indices.byteLength;
      }, 0);
      // 跨层合同 pin:合批器收 threeBridge 单源的 overlay 材质 id(webgpu 侧不值导入)。
      const batcher = new HlodProxyDrawBatcher({ materialId: HLOD_PROXY_MATERIAL_ID });
      const coldStart = performance.now();
      const cold = batcher.update(plan, geometries);
      const batchedColdPlanMs = Number((performance.now() - coldStart).toFixed(4));
      expect(cold.plan.instanceCount).toBe(activeProxies);
      expect(cold.fullRebuild).toBe(true);
      const steady = batcher.update(plan, geometries);
      expect(steady.changedRows).toEqual([]);
      const batchedWarmPlanMs = medianOf(() => batcher.update(plan, geometries), 15);
      const cost = hlodProxyDrawCost(activeProxies, proxyGeometryBytes / activeProxies);
      measurements.push({ label, hiddenInstances: plan.hiddenInstanceIds.size, activeProxies,
        perProxyDraws: cost.perProxyDraws, batchedDraws: cost.batchedDraws,
        drawReduction: cost.drawReduction!, proxyGeometryBytes,
        perProxyActivationBytes: cost.perProxyActivationBytes,
        batchedActivationBytes: unitBytes + activeProxies * 64,
        perProxyPlanMs: medianOf(() => perProxyApplication(plan, geometries), 15),
        batchedColdPlanMs, batchedWarmPlanMs, batchedSteadyChangedRows: steady.changedRows.length });
      // 逐代理路径每帧重铺(144B×N)必须大于合批稳态(0);首激活在 N>11 时合批更小。
      expect(cost.perProxyActivationBytes)
        .toBeGreaterThan(cost.batchedActivationBytes * (activeProxies > 11 ? 1 : 0));
      // 矩阵等价性抽查(每相机首行):合批行 ≡ 逐代理合成(T_draw·M_box)。
      const firstDraw = [...plan.activeProxyDraws.values()][0]!;
      const expected = composeProxyInstanceMatrix(firstDraw.transform,
        hlodProxyBoxExtents(geometries.get(firstDraw.geometryId)!));
      for (let f = 0; f < 16; f++) expect(cold.plan.matrices[f]).toBe(expected[f]);
    }

    const far = measurements[2]!;
    expect(far.label).toBe("远 4×");
    expect(far.hiddenInstances).toBe(TIER);
    expect(far.activeProxies).toBeGreaterThanOrEqual(200);
    expect(far.activeProxies).toBeLessThanOrEqual(280);
    expect(far.batchedDraws).toBe(1);
    expect(far.drawReduction).toBeCloseTo(1 - 1 / far.activeProxies, 10);

    // 相机跳变 delta:远 4× → 航拍 64×,集合大幅变化后仍一次重编、draw 恒 1。
    const aerial = framePlan(tree, fixture,
      decideHlodFrame(tree, workshopCameraAt(sphere, 64)));
    const batcher = new HlodProxyDrawBatcher({ materialId: HLOD_PROXY_MATERIAL_ID });
    batcher.update(farPlan!.plan, farPlan!.geometries);
    const transition = batcher.update(aerial.plan, aerial.geometries);
    expect(transition.fullRebuild).toBe(true);
    expect(transition.changedRows.length).toBe(transition.plan.instanceCount);
    // 跨层合同 pin:批计划的材质/几何 id 与 threeBridge overlay 合同逐值一致。
    expect(transition.plan.materialId).toBe(HLOD_PROXY_MATERIAL_ID);
    expect(transition.plan.geometryId).toBe(HLOD_PROXY_UNIT_GEOMETRY_ID);

    const evidence = { generatedAt: new Date().toISOString(), fixture: {
      tier: TIER, instances: fixture.instances.length,
      note: "T00 车间真实 GLB 包围;决策 targetPixelError=8 迟滞=0.12(默认);"
        + "GPU 为无(mocked),耗时为 CPU 计划层,不代表真机帧时;真机逐 pass GPU 计时 unmeasured" },
      unitGeometry: { id: HLOD_PROXY_UNIT_GEOMETRY_ID, bytes: unitBytes },
      matrixEquivalenceNote: "合批矩阵 = T_draw·M_box,几何等价逐代理绘制(f32 舍入内),逐相机首行钉住",
      cameras: measurements,
      deltaSequence: { from: "远 4×", to: "航拍 64×",
        fullRebuild: transition.fullRebuild, changedRows: transition.changedRows.length },
      realGpuChecklist: [
        "渲染侧把 HLOD 代理 overlay 拆为独立 GPU pass(建议 id hlod-proxy,已登记 PBR_TIMED_PASS_IDS 末尾)",
        "以 GpuTimer.beginPasses 括夹 hlod-proxy,读回 gpu-pass:hlod-proxy 阶段(unmeasured → measured)",
        "合批计划接入传输层:流送路径 authorChunkStream.applyClusterPlan 代理 overlay 换 1 块 + 实例行;"
        + "非流送路径 hlodProxyBatchInstances 行替换逐代理实例(两文件在途域,留主线程接线)",
        "同机同口径复测:draw 数(drawCalls 遥测)、gpu-pass:hlod-proxy ms、帧时 p50/p95",
      ] };
    const outDir = join(process.cwd(), "..", "..", "test-output", "deep-core", "B4-gpu-draw");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "batch-benchmark.json"), JSON.stringify(evidence, null, 2),
      { encoding: "utf-8" });
    console.log("B4-BATCH-BENCH", JSON.stringify(evidence));
  }, 240_000);
});
