import fs from "node:fs/promises";
import { SceneTransformGraph, SceneTransformSpatialBridge, type SceneTransformFlushResult } from "../packages/deep-engine/src/scene/index.js";
import { LooseOctreeIndex } from "../packages/deep-engine/src/spatial/index.js";
import { prepareSceneCommandTransaction, commitSceneCommandTransaction, parseSceneCommand, type SceneCommandTransactionPlan } from "../packages/scene-sdk/src/index.js";
import { SceneGraphTransactionDriver } from "../apps/web/src/commands/SceneGraphTransactionDriver.js";
import { ScenePrimitiveOwner } from "../apps/web/src/commands/ScenePrimitiveOwnerPort.js";

// H-C7-P3 第二批 CLI:单会话多命令编排。
// 1) 原子守卫批:create + 不支持的 material.set(wireframe)→ 整批 rolled-back,状态零变化;
// 2) 四命令混批 [create→set-transform→material.set→delete] 单事务提交,验证原子性与
//    finalFlush(changedNodeIds+removedNodeIds 同时发布);触碰图元经投影解锁后重编译。
// receipt 落盘 test-output/hc7p3-graph-owner-20261002/cli-mixed-batch-receipt.json。
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
  module: { id: "hc7p3-owner-cli", capabilities: ["studio.object", "studio.material"], permissions: ["scene.write"] }, commands });

const phase = async (name: string, commands: unknown[]) => {
  const prepared = prepareSceneCommandTransaction(request(name, commands));
  if (prepared.status !== "prepared") throw Error(`prepare rejected: ${JSON.stringify(prepared.issues)}`);
  const host = driver(prepared.plan);
  const outcome = await commitSceneCommandTransaction(prepared.plan, host);
  return { name, outcome, host, finalFlush: host.finalFlush as SceneTransformFlushResult<string> | undefined };
};
const flushSummary = (finalFlush: SceneTransformFlushResult<string> | undefined) => finalFlush && {
  revision: finalFlush.revision, changedNodeIds: finalFlush.changedNodeIds, removedNodeIds: finalFlush.removedNodeIds,
};

// 阶段 0:种子图元(混批 delete 的目标)。
const seedPhase = await phase("seed", [{
  id: "seed-create", type: "object.create-primitive",
  target: { kind: "object", sceneId, objectId: "seed-box" }, name: "seed", kind: "box", color: "#3366aa",
}]);
if (seedPhase.outcome.status !== "committed") throw Error(`seed phase: ${seedPhase.outcome.status}`);
spatial.apply(seedPhase.finalFlush!);
const compiledSeedOnly = owner.compileRuntimePackage({ packageId: "scene.owner-cli-pkg", revision: graph.revision });

// 阶段 1:原子守卫批——不支持的材质域必须整批拒绝,状态零变化。
const guardPhase = await phase("atomic-guard", [
  { id: "guard-create", type: "object.create-primitive",
    target: { kind: "object", sceneId, objectId: "guard-box" }, name: "guard", kind: "box", color: "#00ff00" },
  { id: "guard-material", type: "material.set", target: { kind: "object", sceneId, objectId: "guard-box" },
    patch: { wireframe: true } },
]);
if (guardPhase.outcome.status !== "rolled-back") throw Error(`atomic guard expected rolled-back, got ${guardPhase.outcome.status}`);
if (guardPhase.host.finalFlush !== undefined) throw Error("atomic guard published a flush");
const guardClean = !graph.has("guard-box") && !owner.has("guard-box");
if (!guardClean) throw Error("atomic guard left partial state behind");

// 阶段 2:四命令混批(单事务):create→set-transform→material.set→delete。
const mixedPhase = await phase("mixed-batch", [
  { id: "mix-create", type: "object.create-primitive",
    target: { kind: "object", sceneId, objectId: "mix-box" }, name: "mix", kind: "box", color: "#1683ff" },
  { id: "mix-transform", type: "object.set-transform", target: { kind: "object", sceneId, objectId: "mix-box" },
    position: [3, 0, 0], rotation: [0.3, 0.8, -0.4], scale: [2, 0.5, 1.5] },
  { id: "mix-material", type: "material.set", target: { kind: "object", sceneId, objectId: "mix-box" },
    patch: { color: "#ff8800", metalness: 0.8, roughness: 0.25 } },
  { id: "mix-delete", type: "object.delete-primitive", target: { kind: "object", sceneId, objectId: "seed-box" } },
]);
if (mixedPhase.outcome.status !== "committed") throw Error(`mixed batch: ${mixedPhase.outcome.status}`);
const mixedFlush = mixedPhase.finalFlush!;
spatial.apply(mixedFlush);
const changed = [...mixedFlush.changedNodeIds], removed = [...mixedFlush.removedNodeIds];
if (!changed.includes("mix-box") || !removed.includes("seed-box")) {
  throw Error(`unexpected finalFlush: changed=${JSON.stringify(changed)} removed=${JSON.stringify(removed)}`);
}

// 投影解锁断言:触碰图元重编译通过,实例矩阵与 graph 世界矩阵一致(f32 包容差 1e-6)。
const mixNode = graph.getNode("mix-box");
if (!mixNode) throw Error("mix-box node missing after mixed batch");
if (Math.abs(mixNode.worldMatrix[12]! - 3) > 1e-9) throw Error(`mix-box world X unexpected: ${mixNode.worldMatrix[12]}`);
const mixState = owner.get("mix-box");
if (!mixState) throw Error("mix-box primitive missing from owner registry");
const projected = {
  position: mixState.transform.position, scale: mixState.transform.scale,
  material: mixState.material ?? null, visible: mixState.visible,
};
if (projected.position.x !== 3 || projected.scale.x !== 2) throw Error(`transform projection drifted: ${JSON.stringify(projected)}`);
if (!projected.material || projected.material.color !== "#ff8800" || projected.material.metalness !== 0.8 || projected.material.roughness !== 0.25) {
  throw Error(`material projection unexpected: ${JSON.stringify(projected.material)}`);
}

const queryNear = { min: [1, -2, -2], max: [5, 2, 2] } as const;
const idsNear = index.queryAabb(queryNear).ids;
const querySeed = { min: [-1, -1, -1], max: [-0.5, -0.5, -0.5] } as const; // 种子原包围盒内部、远离移动后的 mix-box。
const idsSeed = index.queryAabb(querySeed).ids;
if (JSON.stringify(idsNear) !== JSON.stringify(["mix-box"])) throw Error(`spatial near unexpected: ${JSON.stringify(idsNear)}`);
if (idsSeed.length !== 0) throw Error(`seed bounds not cleared: ${JSON.stringify(idsSeed)}`);

const compiledMixed = owner.compileRuntimePackage({ packageId: "scene.owner-cli-pkg", revision: graph.revision });
const packet = compiledMixed.runtimePackage.payloads["scene.render"] as Record<string, unknown>;
const instances = packet.instances as Array<Record<string, unknown>>;
const materials = packet.materials as Array<Record<string, unknown>>;
if (JSON.stringify(instances.map(entry => entry.id)) !== JSON.stringify(["mix-box"])) throw Error("packet instances unexpected");
const drift = Math.max(...(instances[0]!.transform as number[]).map((entry, i) => Math.abs(entry - mixNode.worldMatrix[i]!)));
if (drift > 1e-6) throw Error(`packet matrix drift ${drift}`);
if (materials[0]!.metallic !== 0.8 || materials[0]!.roughness !== 0.25) throw Error("packet material values unexpected");

const receipt: Record<string, unknown> = {
  sceneId, schema: "hc7p3-graph-owner-mixed-batch/1",
  atomicGuard: {
    commands: ["object.create-primitive guard-box", "material.set guard-box {wireframe:true}"],
    outcome: guardPhase.outcome.status,
    flushPublished: guardPhase.host.finalFlush !== undefined,
    stateCleanAfterRollback: guardClean,
  },
  phases: [
    { phase: "seed", receipt: seedPhase.outcome.receipt, finalFlush: flushSummary(seedPhase.finalFlush) },
    { phase: "mixed-batch", receipt: mixedPhase.outcome.receipt, finalFlush: flushSummary(mixedPhase.finalFlush),
      commandTypes: ["object.create-primitive", "object.set-transform", "material.set", "object.delete-primitive"],
      ownerProjection: projected,
      node: { id: mixNode.id, parent: mixNode.parent, hidden: mixNode.hidden,
        localBounds: mixNode.localBounds, worldMatrixTranslation: mixNode.worldMatrix.slice(12, 15) },
      spatial: { queryNear, idsNear, querySeed, idsSeed },
      runtimePackage: {
        packageId: compiledMixed.runtimePackage.packageId, schemaVersion: compiledMixed.runtimePackage.schemaVersion,
        packageHash: compiledMixed.runtimePackage.packageHash.value,
        packageHashSeedOnly: compiledSeedOnly.runtimePackage.packageHash.value,
        packageHashChanged: compiledSeedOnly.runtimePackage.packageHash.value !== compiledMixed.runtimePackage.packageHash.value,
        resourceKinds: compiledMixed.runtimePackage.resources.map(entry => entry.kind),
        instances: instances.map(entry => entry.id),
        geometryIds: (packet.geometries as Array<{ id: string }>).map(entry => entry.id),
        material: { id: materials[0]!.id, metallic: materials[0]!.metallic, roughness: materials[0]!.roughness },
        instanceMatrixMaxDriftVsWorld: drift,
      },
    },
  ],
  final: {
    graphRevision: graph.revision, graphNodeCount: graph.size,
    ownerRegistry: owner.list().map(primitive => ({ modelId: primitive.modelId, kind: primitive.kind,
      color: primitive.color, visible: primitive.visible, material: primitive.material ?? null })),
    spatialStats: { trackedTransforms: spatial.stats.trackedTransforms, appliedFlushes: spatial.stats.appliedFlushes, sceneRevision: spatial.stats.sceneRevision },
    atomicityProven: guardPhase.outcome.status === "rolled-back" && guardClean && guardPhase.host.finalFlush === undefined,
    finalFlushSinglePublish: mixedFlush.revision === graph.revision,
  },
};
const json = JSON.stringify(receipt, null, 2) + "\n";
if (outPath) await fs.writeFile(outPath, json);
console.log(json);
