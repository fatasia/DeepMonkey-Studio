import fs from "node:fs/promises";
import { SceneTransformGraph, SceneTransformSpatialBridge, type SceneTransformFlushResult } from "../packages/deep-engine/src/scene/index.js";
import { LooseOctreeIndex } from "../packages/deep-engine/src/spatial/index.js";
import { prepareSceneCommandTransaction, commitSceneCommandTransaction, parseSceneCommand, type SceneCommandTransactionPlan } from "../packages/scene-sdk/src/index.js";
import { SceneGraphTransactionDriver } from "../apps/web/src/commands/SceneGraphTransactionDriver.js";
import { ScenePrimitiveOwner } from "../apps/web/src/commands/ScenePrimitiveOwnerPort.js";

// H-C7-P3 第一批 CLI:Native graph 几何 owner port 真跑一轮。
// 创建 box(真实几何资源实例进 RuntimePackage+graph 节点)→ 空间 bounds 查询 →
// 删除(removeSubtree+资源释放)→ finalFlush 后 bounds 清空。receipt 落盘。
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const sceneId = value("--scene") ?? "native-author";
const outPath = value("--out");

const graph = new SceneTransformGraph<string>();
graph.flush();
const owner = new ScenePrimitiveOwner({ sceneId });
const index = new LooseOctreeIndex<string>({ bounds: { min: [-1_000_000, -1_000_000, -1_000_000], max: [1_000_000, 1_000_000, 1_000_000] } });
const spatial = new SceneTransformSpatialBridge({ kind: "octree", target: index });

const driver = (plan: SceneCommandTransactionPlan) => new SceneGraphTransactionDriver(graph, {
  sceneId, transactionId: plan.id, baseRevision: plan.baseRevision, parser: { parse: parseSceneCommand }, primitiveOwner: owner,
});
const request = (id: string, commands: unknown[]) => ({ id, sceneId, baseRevision: graph.revision,
  module: { id: "hc7p3-owner-cli", capabilities: ["studio.object"], permissions: ["scene.write"] }, commands });

const phase = async (name: string, commands: unknown[]) => {
  const prepared = prepareSceneCommandTransaction(request(name, commands));
  if (prepared.status !== "prepared") throw Error(`prepare rejected: ${JSON.stringify(prepared.issues)}`);
  const host = driver(prepared.plan);
  const outcome = await commitSceneCommandTransaction(prepared.plan, host);
  if (outcome.status !== "committed") throw Error(`commit ${name}: ${outcome.status} ${JSON.stringify(outcome.issue)}`);
  const finalFlush = host.finalFlush as SceneTransformFlushResult<string>;
  spatial.apply(finalFlush);
  return { receipt: outcome.receipt, finalFlush };
};

// 阶段 1:创建真实 box 资源实例。
const createPhase = await phase("create-box", [{
  id: "create-box", type: "object.create-primitive",
  target: { kind: "object", sceneId, objectId: "new-box" }, name: "box", kind: "box", color: "#1683ff",
}]);
const createdNode = graph.getNode("new-box");
const boundsQuery = { min: [-2, -2, -2], max: [2, 2, 2] } as const;
const boundsAfterCreate = index.queryAabb(boundsQuery).ids;
if (JSON.stringify(boundsAfterCreate) !== JSON.stringify(["new-box"])) throw Error(`spatial bounds after create unexpected: ${JSON.stringify(boundsAfterCreate)}`);
const compiledBeforeDelete = owner.compileRuntimePackage({ packageId: "scene.owner-cli-pkg", revision: graph.revision });
const beforePacket = compiledBeforeDelete.runtimePackage.payloads["scene.render"] as Record<string, unknown>;

const receipt: Record<string, unknown> = {
  sceneId, schema: "hc7p3-graph-owner-cli/1", phases: [{
    phase: "create", receipt: createPhase.receipt, finalFlush: {
      revision: createPhase.finalFlush.revision, changedNodeIds: createPhase.finalFlush.changedNodeIds,
      removedNodeIds: createPhase.finalFlush.removedNodeIds,
    },
    node: createdNode && {
      id: createdNode.id, parent: createdNode.parent, localBounds: createdNode.localBounds,
      worldBounds: createdNode.worldBounds, hidden: createdNode.hidden,
    },
    spatialQueryAabb: boundsQuery, spatialIds: boundsAfterCreate,
    runtimePackage: {
      packageId: compiledBeforeDelete.runtimePackage.packageId, schemaVersion: compiledBeforeDelete.runtimePackage.schemaVersion,
      packageHash: compiledBeforeDelete.runtimePackage.packageHash.value,
      resourceKinds: compiledBeforeDelete.runtimePackage.resources.map(entry => entry.kind),
      renderPacketInstances: beforePacket.instances,
      renderPacketGeometryIds: (beforePacket.geometries as Array<{ id: string }>).map(entry => entry.id),
      ownerRegistry: owner.list().map(primitive => ({ modelId: primitive.modelId, kind: primitive.kind, color: primitive.color, visible: primitive.visible })),
    },
  }],
};

// 阶段 2:删除 = removeSubtree + 资源释放。
const deletePhase = await phase("delete-box", [{
  id: "delete-box", type: "object.delete-primitive", target: { kind: "object", sceneId, objectId: "new-box" },
}]);
const boundsAfterDelete = index.queryAabb(boundsQuery).ids;
if (boundsAfterDelete.length !== 0) throw Error(`spatial bounds after delete not empty: ${JSON.stringify(boundsAfterDelete)}`);
const compiledAfterDelete = owner.compileRuntimePackage({ packageId: "scene.owner-cli-pkg", revision: graph.revision });
const afterPacket = compiledAfterDelete.runtimePackage.payloads["scene.render"] as Record<string, unknown>;

receipt.phases.push({
  phase: "delete", receipt: deletePhase.receipt,
  finalFlush: {
    revision: deletePhase.finalFlush.revision, changedNodeIds: deletePhase.finalFlush.changedNodeIds,
    removedNodeIds: deletePhase.finalFlush.removedNodeIds,
  },
  spatialQueryAabb: boundsQuery, spatialIds: boundsAfterDelete,
  runtimePackage: {
    packageHash: compiledAfterDelete.runtimePackage.packageHash.value,
    renderPacketInstances: afterPacket.instances,
    renderPacketGeometryIds: (afterPacket.geometries as Array<{ id: string }>).map(entry => entry.id),
    ownerRegistry: owner.list(),
  },
  resourcesReleased: compiledBeforeDelete.runtimePackage.packageHash.value !== compiledAfterDelete.runtimePackage.packageHash.value,
});
receipt.final = {
  graphRevision: graph.revision, graphNodeCount: graph.size, ownerRegistryCount: owner.list().length,
  spatialStats: { trackedTransforms: spatial.stats.trackedTransforms, appliedFlushes: spatial.stats.appliedFlushes, sceneRevision: spatial.stats.sceneRevision },
  boundsClearedAfterFinalFlush: boundsAfterDelete.length === 0,
};
const json = JSON.stringify(receipt, null, 2) + "\n";
if (outPath) await fs.writeFile(outPath, json);
console.log(json);
