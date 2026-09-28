import { describe, expect, it } from "vitest";
import { WORKSHOP_COUNTS } from "../../lab/factoryWorkshop.js";
import { buildHlodTree } from "./hlodCluster.js";
import { decideHlodFrame } from "./hlodDecision.js";
import type { HlodClusterTree, HlodFrameDecision } from "./hlodTypes.js";
import { workshopCameraAt, workshopHlodFixture, workshopSceneSphere } from "./hlodWorkshopFixture.testUtils.js";

/**
 * T26 统计阶梯(任务目标 4):直接 import T00 车间 fixture 的 `buildWorkshopLayout`
 * (1k/5k/10k 冻结布局,只读),实例包围球来自 lab/assets 8 份派生 GLB 的
 * **真实** POSITION accessor min/max(经节点层级变换,经共享夹具 workshopHlodFixture),
 * 不做任何估算。相机经 `workshopCameraAt`(createFactoryWorkshopScene 偏移约定,
 * fov π/4,540p);距离倍率 0.25/1/4/64 覆盖近景→巡航→远航→整簇折叠。
 */

/** 车间布局 → HLOD 实例集(id 与 composeWorkshopPacket 同约定:`placementIndex/节点`)。 */
const workshopInstances = async (count: (typeof WORKSHOP_COUNTS)[number]) =>
  (await workshopHlodFixture(count)).instances;
interface SceneSphere { readonly center: readonly [number, number, number]; readonly extent: number }

const cameraAt = (sphere: SceneSphere, distanceScale: number) => workshopCameraAt(sphere, distanceScale);

const levelHistogram = (tree: HlodClusterTree): string => {
  const levels = new Map<number, number>();
  for (const node of tree.nodes.values()) levels.set(node.level, (levels.get(node.level) ?? 0) + 1);
  return [...levels.entries()].sort((a, b) => a[0] - b[0])
    .map(([level, count]) => `L${level}:${count}`).join(" ");
};

const decisionRow = (label: string, decision: HlodFrameDecision): string =>
  `  ${label.padEnd(10)} 渲染实例 ${String(decision.renderedInstances).padStart(6)}`
    + ` 隐藏 ${String(decision.hiddenInstances).padStart(6)}`
    + ` 代理覆盖率 ${(decision.proxyCoverage * 100).toFixed(1).padStart(5)}%`
    + ` 折叠簇 ${String(decision.collapsedNodes.length).padStart(4)}`
    + ` 访问节点 ${String(decision.visitedNodes).padStart(5)}`;

describe("T26 statistics ladder on the T00 workshop layout", () => {
  it("builds and decides the 1k/5k/10k tiers with real GLB bounds (report table)", async () => {
    const rows: string[] = [];
    for (const count of WORKSHOP_COUNTS) {
      const instances = await workshopInstances(count);
      const sphere = workshopSceneSphere(instances);
      const startedAt = performance.now();
      const tree = buildHlodTree(instances, { maxChildren: 8 });
      const buildMs = performance.now() - startedAt;
      // 结构不变式:
      expect(tree.stats.leafCount).toBe(count);
      expect(tree.stats.maxFanout).toBeLessThanOrEqual(8);
      expect(tree.stats.depth).toBeLessThanOrEqual(tree.options.maxDepth);
      expect(tree.stats.internalCount).toBeGreaterThan(0);

      rows.push(`[${count} 实例] extent=${sphere.extent.toFixed(1)}m 根胞元side=${tree.rootCell.side}`
        + ` 构建 ${buildMs.toFixed(1)}ms`);
      rows.push(`  节点 ${tree.stats.nodeCount} = 叶 ${tree.stats.leafCount} + 簇 ${tree.stats.internalCount}`
        + ` | 深度 ${tree.stats.depth} | 最大扇出 ${tree.stats.maxFanout} | ${levelHistogram(tree)}`);
      const near = decideHlodFrame(tree, cameraAt(sphere, 0.25));
      const base = decideHlodFrame(tree, cameraAt(sphere, 1));
      const far = decideHlodFrame(tree, cameraAt(sphere, 4));
      const aerial = decideHlodFrame(tree, cameraAt(sphere, 64));
      rows.push("  决策(targetPixelError=8,迟滞 0.12):");
      rows.push(decisionRow("近 0.25×", near));
      rows.push(decisionRow("巡航 1×", base));
      rows.push(decisionRow("远 4×", far));
      rows.push(decisionRow("航拍 64×", aerial));
      // 语义不变式:越远隐藏越多;航拍整簇折叠;近景有实例渲染。
      // (小档在 0.25× 机位可能全渲染,大档远处小簇会合法折叠——数值见表。)
      expect(near.hiddenInstances).toBeLessThanOrEqual(base.hiddenInstances);
      expect(base.hiddenInstances).toBeLessThanOrEqual(far.hiddenInstances);
      expect(far.hiddenInstances).toBeLessThanOrEqual(aerial.hiddenInstances);
      expect(aerial.hiddenInstances).toBe(count);
      expect(near.renderedInstances).toBeGreaterThan(0);

      const sweep: string[] = [];
      let previousCovered = -1;
      for (const targetPixelError of [1, 2, 4, 8, 16, 32]) {
        const decision = decideHlodFrame(tree, cameraAt(sphere, 1), { targetPixelError });
        sweep.push(`${targetPixelError}px:${(decision.proxyCoverage * 100).toFixed(0)}%`);
        expect(decision.hiddenInstances).toBeGreaterThanOrEqual(previousCovered);
        previousCovered = decision.hiddenInstances;
      }
      rows.push(`  阈值阶梯(巡航机位):${sweep.join("  ")}`);
      expect(sweep).toHaveLength(6);

      // 确定性:同输入重建逐位同树(摘要口径)。
      const rebuilt = buildHlodTree(instances, { maxChildren: 8 });
      expect(rebuilt.rootId).toBe(tree.rootId);
      expect(rebuilt.stats).toEqual(tree.stats);
      expect([...rebuilt.nodes.keys()].sort()).toEqual([...tree.nodes.keys()].sort());
    }
    console.log(`\n[T26 统计阶梯]\n${rows.join("\n")}\n`);
  }, 120_000);

  it("is byte-stable across repeated instance construction (layout + bounds pipeline)", async () => {
    const first = JSON.stringify(await workshopInstances(1_000));
    const second = JSON.stringify(await workshopInstances(1_000));
    expect(second).toBe(first);
  });
});
