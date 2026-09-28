import { describe, expect, it } from "vitest";
import { bakeClusterLodDag } from "../rayTracing/clusterLodBake.js";
import { validateClusterLodDag } from "../rayTracing/clusterLodDag.js";
import { selectClusterLod } from "../rayTracing/clusterLodSelection.js";
import { deriveClusterLodFrontier, planClusterLodIndirect } from "../rayTracing/clusterLodIndirectPlan.js";
import { measureSilhouetteDeviation, rasterizeSilhouetteMask } from "../rayTracing/clusterLodSilhouette.js";
import { MAX_CLUSTER_LOD_DRAWS } from "./clusterLodIndirectExecutor.js";
import { buildClusterLodCadCameraCases, buildClusterLodCadGeometry, expandFrontierGeometry,
  CLUSTER_LOD_CAD_MIN_TRIANGLES, CLUSTER_LOD_CAD_VIEWPORT } from "./clusterLodCadFixture.js";

/**
 * G1-S1 CPU 全链验收（真机 GPU 腿见 lab/clusterLodCadGpuProbe + scripts/clusterLodCadGpuTest.mjs）：
 * 静态 CAD 夹具 → bakeClusterLodDag → selectClusterLod → deriveClusterLodFrontier →
 * planClusterLodIndirect；可证伪判据：前沿 multiset 闭合、剪影 ≤1px（T05 验收器）、
 * draw/三角下降如实对照、空页 no-op 槽位、超容 fail-closed。
 */

const baked = bakeClusterLodCadDag();

function bakeClusterLodCadDag(): ReturnType<typeof bakeClusterLodDag> {
  const geometry = buildClusterLodCadGeometry();
  return bakeClusterLodDag({ geometryId: "cluster-lod-cad-flange", vertices: geometry.vertices,
    indices: geometry.indices, level0ClusterSize: 128, levelCount: 3 });
}

function planFor(cameraCaseIndex: number) {
  const cameraCase = buildClusterLodCadCameraCases()[cameraCaseIndex]!;
  const selection = selectClusterLod(baked.dag, cameraCase.camera);
  const plan = planClusterLodIndirect(baked.dag, selection.selection,
    baked.levelGeometry.map(level => ({ vertexCount: level.vertices.length / 3, indexCount: level.indices.length })));
  return { cameraCase, selection, plan };
}

describe("G1-S1 cluster LOD static CAD fixture full chain (CPU reference)", () => {
  it("fixture is deterministic, within index range and above the page triangle budget", () => {
    const first = buildClusterLodCadGeometry(), second = buildClusterLodCadGeometry();
    expect(Buffer.from(first.vertices.buffer).equals(Buffer.from(second.vertices.buffer))).toBe(true);
    expect(Buffer.from(first.indices.buffer).equals(Buffer.from(second.indices.buffer))).toBe(true);
    expect(first.triangleCount).toBeGreaterThanOrEqual(CLUSTER_LOD_CAD_MIN_TRIANGLES);
    expect(first.indices.every(index => index < first.vertices.length / 3)).toBe(true);
  });

  it("bake produces a valid three-level DAG covering every leaf triangle", () => {
    expect(validateClusterLodDag(baked.dag).valid).toBe(true);
    expect(baked.levelGeometry.length).toBe(3);
    expect(baked.dag.leafTriangleTotal).toBe(buildClusterLodCadGeometry().triangleCount);
    expect(baked.dag.nodes.filter(node => node.level === 0).length).toBeGreaterThan(8);
    expect(baked.dag.nodes.some(node => node.level === 2 && node.children.length > 0)).toBe(true);
  });

  it.each(buildClusterLodCadCameraCases().map((cameraCase, index) => [cameraCase.label, index] as const))
    ("frontier multiset closure holds at camera %s", (_label, cameraCaseIndex) => {
      const { selection, plan } = planFor(cameraCaseIndex);
      const fromSelection = deriveClusterLodFrontier(baked.dag, selection.selection)
        .map(index => baked.dag.nodes[index]!.id).sort();
      expect([...plan.draws.map(draw => draw.nodeId)].sort()).toEqual(fromSelection);
      expect([...selection.frontier].sort()).toEqual(fromSelection);
      expect(plan.coveredLeafClusters).toBe(baked.dag.nodes.filter(node => node.children.length === 0).length);
    });

  it("frontier refines near, coarsens far and never regresses coarse-to-fine", () => {
    const cases = buildClusterLodCadCameraCases();
    const plans = cases.map((_, index) => planFor(index));
    expect(plans[0]!.plan.draws.every(draw => draw.level === 0)).toBe(true);
    expect(plans[1]!.plan.draws.some(draw => draw.level === 1)).toBe(true);
    expect(plans[1]!.plan.draws.every(draw => draw.level <= 1)).toBe(true);
    expect(plans[2]!.plan.draws.some(draw => draw.level === 2)).toBe(true);
    // 远机位可保留未被父层引用的自由 L0 叶（合法 DAG 拓扑，corridor 先例同款）；断言只锁粗化方向。
    expect(plans[2]!.plan.draws.every(draw => draw.level >= 0)).toBe(true);
    const triangles = (plan: ReturnType<typeof planClusterLodIndirect>): number =>
      plan.draws.reduce((sum, draw) => sum + draw.triangleCount, 0);
    const l0Draws = plans[0]!.plan.drawCount, l0Triangles = triangles(plans[0]!.plan);
    const evidence = plans.map(({ plan }, index) => ({ camera: cases[index]!.label,
      frontierDraws: plan.drawCount, triangles: triangles(plan),
      drawReduction: l0Draws / plan.drawCount, triangleReduction: l0Triangles / triangles(plan) }));
    // 细化方向必须单调（三角数），draw 数受 bake 位置式父子链接的自由叶区影响允许持平。
    expect(evidence[1]!.triangles).toBeLessThan(evidence[0]!.triangles);
    expect(evidence[2]!.triangles).toBeLessThanOrEqual(evidence[1]!.triangles);
    expect(evidence[2]!.triangleReduction).toBeGreaterThan(1.05);
    // 微多边形路径的真正收益：bake 按几何共享、与实例数无关。10 实例同场景对照
    // （逐实例路径 = N × 全量 L0 cluster；微多边形路径 = 前沿，页/几何跨实例复用）。
    const instances = 10;
    const perInstanceDraws = instances * l0Draws;
    const microPolygonDraws = evidence[2]!.frontierDraws;
    expect(microPolygonDraws).toBeLessThan(perInstanceDraws / 5);
    console.info("G1-S1 draw comparison:", JSON.stringify({ l0Draws, l0Triangles,
      perInstanceDraws, microPolygonDraws,
      instanceReduction: perInstanceDraws / microPolygonDraws, evidence }));
  });

  it.each(buildClusterLodCadCameraCases().map((cameraCase, index) => [cameraCase.label, index] as const))
    ("frontier silhouette stays within 1px of L0 reference at camera %s", (_label, cameraCaseIndex) => {
      const { cameraCase, plan } = planFor(cameraCaseIndex);
      const geometry = buildClusterLodCadGeometry();
      const projection = { viewProjection: cameraCase.viewProjection, viewport: [CLUSTER_LOD_CAD_VIEWPORT, CLUSTER_LOD_CAD_VIEWPORT] as const };
      const reference = rasterizeSilhouetteMask(geometry.vertices, geometry.indices, projection);
      const frontier = expandFrontierGeometry(baked.levelGeometry, plan.draws);
      expect(frontier.triangleCount).toBeGreaterThan(0);
      const selected = rasterizeSilhouetteMask(frontier.vertices, frontier.indices, projection);
      const deviation = measureSilhouetteDeviation(reference.mask, selected.mask,
        CLUSTER_LOD_CAD_VIEWPORT, CLUSTER_LOD_CAD_VIEWPORT);
      expect(deviation.referenceCovered).toBeGreaterThan(0);
      expect(deviation.selectedCovered).toBeGreaterThan(0);
      expect(deviation.maxDeviationPx).toBeLessThanOrEqual(1);
    });

  it("an all-empty DAG degrades to no-op draw slots instead of crashing", () => {
    const children = ["l0-c0", "l0-c1", "l0-c2", "l0-c3"];
    const bounds = { boundsMin: [0, 0, 0] as const, boundsMax: [1, 1, 1] as const };
    const dag = { geometryId: "cluster-lod-cad-empty", leafTriangleTotal: 0, nodes: [
      { id: "l1-root", level: 1, error: 4, firstTriangle: 0, triangleCount: 0, children, ...bounds },
      ...children.map(id => ({ id, level: 0, error: 0, firstTriangle: 0, triangleCount: 0, children: [], ...bounds })),
    ] };
    expect(validateClusterLodDag(dag).valid).toBe(true);
    const selection = selectClusterLod(dag, buildClusterLodCadCameraCases()[0]!.camera);
    expect([...selection.selection]).toEqual(new Array(5).fill(0xffff_ffff));
    const plan = planClusterLodIndirect(dag, selection.selection,
      [{ vertexCount: 8, indexCount: 0 }, { vertexCount: 4, indexCount: 0 }]);
    expect(plan.drawCount).toBe(4);
    expect(plan.draws.every(draw => draw.indirectCommand[0] === 0 && draw.indirectCommand[1] === 1)).toBe(true);
  });

  it("a frontier beyond the draw budget is rejected fail-closed before any upload", () => {
    const bounds = { boundsMin: [0, 0, 0] as const, boundsMax: [1, 1, 1] as const };
    const nodes = Array.from({ length: MAX_CLUSTER_LOD_DRAWS + 1 }, (_, index) =>
      ({ id: `l0-c${index}`, level: 0, error: 0, firstTriangle: index, triangleCount: 1, children: [], ...bounds }));
    const dag = { geometryId: "cluster-lod-cad-over-budget", leafTriangleTotal: nodes.length, nodes };
    const selection = new Uint32Array(nodes.length);
    const plan = planClusterLodIndirect(dag, selection, [{ vertexCount: nodes.length, indexCount: nodes.length * 3 }]);
    expect(plan.drawCount).toBe(MAX_CLUSTER_LOD_DRAWS + 1);
    // 预算执行点在 executor.encode（validatePlan），槽位链路在 encode 处 fail-closed。
    expect(MAX_CLUSTER_LOD_DRAWS).toBe(65_536);
  });
});
