import { describe, expect, it } from "vitest";
import { buildHlodTree } from "./hlodCluster.js";
import { decideHlodFrame } from "./hlodDecision.js";
import { generateHlodProxiesForFrame } from "./hlodProxyBatch.js";
import type { HlodClusterTree, HlodFrameDecision } from "./hlodTypes.js";
import { workshopCameraAt, workshopHlodFixture, workshopSceneSphere, type WorkshopHlodFixture } from "./hlodWorkshopFixture.testUtils.js";

/**
 * T26 第二切片端到端 CPU 验证:决策(第一切片)→ 簇级代理几何(本切片)。
 * 1k/10k 车间档(真实 GLB 包围 + 真实三角形数),四机位阶梯 + 预算扫描:
 * 代理覆盖率 / 三角形削减率 / 误差度量全部实测输出,供报告引用。
 */

const TIERS = [1_000, 10_000] as const;
const CAMERAS = [["近 0.25×", 0.25], ["巡航 1×", 1], ["远 4×", 4], ["航拍 64×", 64]] as const;

interface TierContext {
  readonly count: number;
  readonly fixture: WorkshopHlodFixture;
  readonly tree: HlodClusterTree;
  readonly totalTriangles: number;
}

const tierContext = async (count: (typeof TIERS)[number]): Promise<TierContext> => {
  const fixture = await workshopHlodFixture(count);
  const tree = buildHlodTree(fixture.instances, { maxChildren: 8 });
  const totalTriangles = [...fixture.trianglesByInstance.values()].reduce((sum, value) => sum + value, 0);
  return { count, fixture, tree, totalTriangles };
};

const decide = (context: TierContext, distanceScale: number): HlodFrameDecision =>
  decideHlodFrame(context.tree, workshopCameraAt(workshopSceneSphere(context.fixture.instances), distanceScale));

const batchOf = (context: TierContext, frame: HlodFrameDecision, maxProxyTriangles?: number) =>
  generateHlodProxiesForFrame(context.tree, context.fixture.shapes, frame,
    maxProxyTriangles === undefined ? { trianglesByInstance: context.fixture.trianglesByInstance }
      : { trianglesByInstance: context.fixture.trianglesByInstance, maxProxyTriangles });

const perClusterRadiusMax = (context: TierContext, frame: HlodFrameDecision): number => {
  let max = 0;
  for (const decision of frame.collapsedNodes) {
    const node = context.tree.nodes.get(decision.nodeId)!;
    max = Math.max(max, node.radius);
  }
  return max;
};

describe("T26 proxy statistics ladder on the T00 workshop layout", () => {
  it("couples decisions to cluster proxies across 1k/10k tiers (report table)", async () => {
    const rows: string[] = [];
    for (const count of TIERS) {
      const context = await tierContext(count);
      const [instances, shapes, triangles] = [context.fixture.instances, context.fixture.shapes,
        context.fixture.trianglesByInstance] as const;
      expect(triangles.size).toBe(instances.length);
      expect(context.totalTriangles).toBeGreaterThan(0);
      rows.push(`[${count} 实例] 源三角形总数 ${context.totalTriangles.toLocaleString("en-US")}`);

      let previousHidden = -1;
      for (const [label, scale] of CAMERAS) {
        const frame = decide(context, scale);
        const startedAt = performance.now();
        const batch = batchOf(context, frame);
        const batchMs = performance.now() - startedAt;
        // 覆盖一致性:代理批恰好平铺隐藏实例集。
        expect(batch.totals.coveredInstances).toBe(frame.hiddenInstances);
        expect(batch.totals.proxyCount).toBe(frame.collapsedNodes.length);
        for (const entry of batch.entries) {
          expect(entry.proxy.mesh.triangleCount).toBeLessThanOrEqual(96);
          expect(Number.isFinite(entry.metrics.instanceToProxyMax)).toBe(true);
          expect(Number.isFinite(entry.metrics.proxyToInstanceMax)).toBe(true);
        }
        expect(frame.hiddenInstances).toBeGreaterThanOrEqual(previousHidden);
        previousHidden = frame.hiddenInstances;
        const reduction = batch.totals.triangleReductionRatio;
        const reductionText = reduction !== null && Number.isFinite(reduction)
          ? (reduction * 100).toFixed(2).padStart(6) : "     —";
        rows.push(`  ${label.padEnd(9)} 渲染 ${String(frame.renderedInstances).padStart(6)}`
          + ` 隐藏 ${String(frame.hiddenInstances).padStart(6)}`
          + ` 代理 ${String(batch.totals.proxyCount).padStart(5)} 个`
          + ` 代理三角形 ${String(batch.totals.proxyTriangleCount).padStart(7)}`
          + ` / 隐藏源三角形 ${String(batch.totals.originalTriangles).padStart(9)}`
          + ` 削减 ${reductionText}%`
          + ` 实例→代理最大 ${batch.totals.instanceToProxyMax.toFixed(3)}m`
          + ` (${batchMs.toFixed(0)}ms)`);
        // 误差量纲:有向采样距离不得超过所在簇包围球半径(盒摘要 ⊆ 簇球,间隙 ≤ 簇球)。
        if (batch.entries.length > 0) {
          expect(batch.totals.instanceToProxyMax)
            .toBeLessThanOrEqual(perClusterRadiusMax(context, frame) + 1e-6);
        }
      }

      // 预算扫描(巡航机位):面数预算是硬约束且单调可控。
      const sweep: string[] = [];
      for (const budget of [12, 24, 48, 96, 192]) {
        const frame = decide(context, 1);
        const batch = batchOf(context, frame, budget);
        const capped = budget === 12 ? 12 : Math.floor(budget / 12) * 12;
        expect(batch.totals.proxyTriangleCount)
          .toBeLessThanOrEqual(batch.totals.proxyCount * capped);
        sweep.push(`${budget}px→${batch.totals.proxyTriangleCount}`
          + `(${batch.totals.triangleReductionRatio === null
            ? "—"
            : ((batch.totals.triangleReductionRatio * 100).toFixed(1) + "%")})`);
      }
      rows.push(`  预算阶梯(巡航):${sweep.join("  ")}`);

      // 确定性:同输入重复生成 → 汇总逐位一致 + 逐条目网格一致(抽查最大簇)。
      const frame = decide(context, 4);
      const first = batchOf(context, frame);
      const second = batchOf(context, frame);
      expect(second.totals).toEqual(first.totals);
      const biggest = first.entries.reduce((a, b) => a.proxy.mesh.triangleCount >= b.proxy.mesh.triangleCount ? a : b);
      const counterpart = second.entries.find(entry => entry.nodeId === biggest.nodeId)!;
      expect(counterpart.proxy.mesh.vertices).toEqual(biggest.proxy.mesh.vertices);
      rows.push(`  确定性:远 4× 批重复生成一致;最大簇 ${biggest.nodeId.slice(0, 18)}…`
        + ` (${biggest.instanceCount} 实例 → ${biggest.proxy.mesh.triangleCount} 三角,`
        + ` instanceToProxyMax ${biggest.metrics.instanceToProxyMax.toFixed(4)}m)`);
    }
    console.log(`\n[T26 代理网格统计阶梯]\n${rows.join("\n")}\n`);
  }, 240_000);

  it("keeps cluster proxies bit-identical across repeated fixture builds (10k far tier)", async () => {
    const context = await tierContext(10_000);
    const frame = decide(context, 4);
    const first = batchOf(context, frame);
    const rebuilt = await tierContext(10_000);
    expect(rebuilt.tree.rootId).toBe(context.tree.rootId);
    const second = batchOf(rebuilt, decide(rebuilt, 4));
    expect(second.totals).toEqual(first.totals);
    for (const [index, entry] of first.entries.entries()) {
      expect(second.entries[index]!.proxy.mesh.vertices).toEqual(entry.proxy.mesh.vertices);
    }
  }, 240_000);
});
