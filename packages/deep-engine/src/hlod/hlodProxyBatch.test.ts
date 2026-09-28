import { describe, expect, it } from "vitest";
import { buildHlodTree } from "./hlodCluster.js";
import { decideHlodFrame } from "./hlodDecision.js";
import { updateHlodTree } from "./hlodIncremental.js";
import type { ClusterLodCamera } from "../rayTracing/clusterLodSelection.js";
import { HlodError, type HlodFrameDecision, type HlodInstanceInput } from "./hlodTypes.js";
import {
  generateHlodClusterProxies,
  generateHlodProxiesForFrame,
} from "./hlodProxyBatch.js";
import type { HlodInstanceShape } from "./hlodProxyTypes.js";

/** 4×4×4 网格,64 实例,间距 10,半径 1。 */
const gridInstances = (): HlodInstanceInput[] => {
  const instances: HlodInstanceInput[] = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
    instances.push({ id: `i${x}${y}${z}`, position: [x * 10, y * 10, z * 10], radius: 1 });
  }
  return instances;
};

const shapeOf = (instance: HlodInstanceInput): HlodInstanceShape =>
  ({ instanceId: instance.id, min: [instance.position[0] - instance.radius, instance.position[1] - instance.radius,
    instance.position[2] - instance.radius],
  max: [instance.position[0] + instance.radius, instance.position[1] + instance.radius,
    instance.position[2] + instance.radius] });

const shapesOf = (instances: readonly HlodInstanceInput[]): HlodInstanceShape[] => instances.map(shapeOf);

const cameraFar = (): ClusterLodCamera => ({
  position: [500, 500, 500], forward: [-1, -1, -1].map(value => value / Math.sqrt(3)) as [number, number, number],
  viewportHeightPixels: 540, tanHalfFovY: Math.tan(Math.PI / 8), pixelThreshold: 1,
});
const cameraNear = (): ClusterLodCamera => ({
  position: [-40, -40, -40], forward: [1, 1, 1].map(value => value / Math.sqrt(3)) as [number, number, number],
  viewportHeightPixels: 540, tanHalfFovY: Math.tan(Math.PI / 8), pixelThreshold: 1,
});

describe("generateHlodClusterProxies", () => {
  const instances = gridInstances();
  const shapes = shapesOf(instances);
  const tree = buildHlodTree(instances);
  const triangles = new Map(instances.map(instance => [instance.id, 100]));

  it("produces proxies whose member sets exactly tile the hidden instances", () => {
    const frame = decideHlodFrame(tree, cameraFar());
    expect(frame.collapsedNodes.length).toBeGreaterThan(0);
    const batch = generateHlodProxiesForFrame(tree, shapes, frame, { trianglesByInstance: triangles });
    expect(batch.entries.map(entry => entry.nodeId)).toEqual(
      [...batch.entries.map(entry => entry.nodeId)].sort());
    expect(batch.totals.coveredInstances).toBe(frame.hiddenInstances);
    expect(batch.totals.proxyCount).toBe(frame.collapsedNodes.length);
    // 预算硬约束 + 成员数 = instanceCount + 指标有限。
    for (const entry of batch.entries) {
      expect(entry.proxy.mesh.triangleCount).toBeLessThanOrEqual(96);
      expect(entry.proxy.budget.inputShapeCount).toBe(entry.instanceCount);
      expect(Number.isFinite(entry.metrics.instanceToProxyMax)).toBe(true);
      expect(entry.instanceCount).toBeGreaterThan(1); // 叶不可折叠,折叠簇成员 ≥ 2
    }
    expect(batch.totals.proxyTriangleCount).toBe(
      batch.entries.reduce((sum, entry) => sum + entry.proxy.mesh.triangleCount, 0));
    expect(batch.totals.triangleReductionRatio).not.toBeNull();
  });

  it("computes per-cluster and total triangle accounting from the real source table", () => {
    const frame = decideHlodFrame(tree, cameraFar());
    const batch = generateHlodProxiesForFrame(tree, shapes, frame, { trianglesByInstance: triangles });
    const entry = batch.entries[0]!;
    expect(entry.originalTriangles).toBe(entry.instanceCount * 100);
    expect(entry.triangleSavingRatio).toBeCloseTo(1 - entry.proxy.mesh.triangleCount / (entry.instanceCount * 100), 12);
    const expectedOriginal = batch.entries.reduce(
      (sum, candidate) => sum + (candidate.originalTriangles ?? 0), 0);
    expect(batch.totals.originalTriangles).toBe(expectedOriginal);
  });

  it("keeps proxy geometry bit-identical for clusters untouched by an incremental move", () => {
    const before = decideHlodFrame(tree, cameraFar());
    const batchBefore = generateHlodProxiesForFrame(tree, shapes, before, { trianglesByInstance: triangles });
    const movedInstance: HlodInstanceInput = { id: "i000", position: [0.5, 0, 0], radius: 1 };
    const { tree: updated } = updateHlodTree(tree, { moved: [movedInstance] });
    const shapesUpdated = shapesOf(gridInstances().map(instance =>
      instance.id === "i000" ? movedInstance : instance));
    const after = decideHlodFrame(updated, cameraFar());
    const batchAfter = generateHlodProxiesForFrame(updated, shapesUpdated, after, { trianglesByInstance: triangles });
    // 两帧共有的簇节点(内容未变 → 内容 id 未变)必须给出逐位相同的代理。
    const idsBefore = new Set(batchBefore.entries.map(entry => entry.nodeId));
    const shared = batchAfter.entries.filter(entry => idsBefore.has(entry.nodeId));
    expect(shared.length).toBeGreaterThan(0);
    for (const entry of shared) {
      const previous = batchBefore.entries.find(candidate => candidate.nodeId === entry.nodeId)!;
      expect(entry.geometryId).toBe(previous.geometryId);
      expect(Buffer.from(entry.proxy.mesh.vertices).equals(Buffer.from(previous.proxy.mesh.vertices))).toBe(true);
      expect(Buffer.from(entry.proxy.mesh.indices).equals(Buffer.from(previous.proxy.mesh.indices))).toBe(true);
    }
  });

  it("is deterministic across repeated invocations", () => {
    const frame = decideHlodFrame(tree, cameraFar());
    const first = generateHlodProxiesForFrame(tree, shapes, frame, { trianglesByInstance: triangles });
    const second = generateHlodProxiesForFrame(tree, shapes, frame, { trianglesByInstance: triangles });
    expect(second).toEqual(first);
  });

  it("fails closed on duplicate targets, unknown nodes, leaf targets and missing shapes", () => {
    const frame = decideHlodFrame(tree, cameraFar());
    const target = frame.collapsedNodes[0]!.nodeId;
    expect(() => generateHlodClusterProxies(tree, shapes, [target, target])).toThrow(/Duplicate proxy target/);
    expect(() => generateHlodClusterProxies(tree, shapes, ["nope"])).toThrow(HlodError);
    const leaf = [...tree.nodes.values()].find(node => node.children.length === 0)!;
    expect(() => generateHlodClusterProxies(tree, shapes, [leaf.id])).toThrow(/leaf/);
    const partial = shapes.slice(1);
    expect(() => generateHlodClusterProxies(tree, partial, [target])).toThrow(/has no instance shape/);
  });

  it("rejects a malformed frame decision and a triangles table missing members", () => {
    expect(() => generateHlodProxiesForFrame(tree, shapes, {} as HlodFrameDecision)).toThrow(/malformed/);
    const frame = decideHlodFrame(tree, cameraFar());
    const target = frame.collapsedNodes[0]!.nodeId;
    expect(() => generateHlodClusterProxies(tree, shapes, [target],
      { trianglesByInstance: new Map([["i000", 1]]) })).toThrow(/missing from trianglesByInstance/);
  });

  it("renders nothing for a near camera without collapsed clusters (empty batch is legal)", () => {
    const frame = decideHlodFrame(tree, cameraNear());
    if (frame.collapsedNodes.length === 0) {
      const batch = generateHlodProxiesForFrame(tree, shapes, frame);
      expect(batch.entries).toHaveLength(0);
      expect(batch.totals.proxyCount).toBe(0);
      expect(batch.totals.triangleReductionRatio).toBeNull();
    }
  });
});
