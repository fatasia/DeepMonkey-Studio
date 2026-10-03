import fs from "node:fs/promises";
import { SceneTransformGraph, SceneTransformSpatialBridge, type SceneTransformFlushResult } from "../packages/deep-engine/src/scene/index.js";
import { LooseOctreeIndex } from "../packages/deep-engine/src/spatial/index.js";
import { prepareSceneCommandTransaction, commitSceneCommandTransaction, parseSceneCommand, type SceneCommandTransactionPlan } from "../packages/scene-sdk/src/index.js";
import { SceneGraphTransactionDriver } from "../apps/web/src/commands/SceneGraphTransactionDriver.js";
import { ScenePrimitiveOwner, restoreSceneFromSnapshot } from "../apps/web/src/commands/ScenePrimitiveOwnerPort.js";
import { SceneCameraOwner } from "../apps/web/src/commands/SceneCameraPort.js";
import { SceneReferenceRegistry } from "../apps/web/src/commands/SceneReferenceCleanupPort.js";
import type { SceneSnapshot } from "../packages/contracts/src/index.js";

// H-C7-P3 第三批 CLI:保存重开轮。
// 1) author:三图元(移动+材质+隐藏)+ selectionSet/rootLayerOrder 引用 + camera.set + fly-to(单事务 committed);
// 2) snapshot:owner.snapshotScene 导出 + 相机/引用容器随快照 → JSON 真实序列化往返;
// 3) reopen:restoreSceneFromSnapshot 水合 + 相机/引用 port 接回 → 包哈希与保存前逐字节一致;
// 4) post-reopen:重开场景继续作者 [set-transform + delete 引用图元 + fly-to] 携 referenceCleanup 提交,
//    引用清理/投影/包哈希变化全部断言。receipt 落盘 test-output/hc7p3-graph-owner-20261002/cli-save-reopen-receipt.json。
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const sceneId = value("--scene") ?? "native-author";
const outPath = value("--out");

const graph = new SceneTransformGraph<string>();
graph.flush();
const owner = new ScenePrimitiveOwner({ sceneId });
const camera = new SceneCameraOwner({ sceneId });
const refs = new SceneReferenceRegistry({ sceneId, containers: {
  selectionSets: [{ id: "g1", name: "机组 A", objectIds: ["re-box", "victim-box"] }],
  rootLayerOrder: [{ kind: "object", id: "re-box" }, { kind: "object", id: "victim-box" }, { kind: "object", id: "hidden-box" }],
} });
const index = new LooseOctreeIndex<string>({ bounds: { min: [-1_000_000, -1_000_000, -1_000_000], max: [1_000_000, 1_000_000, 1_000_000] } });
const spatial = new SceneTransformSpatialBridge({ kind: "octree", target: index });

const driver = (plan: SceneCommandTransactionPlan, scope: { graph: SceneTransformGraph<string>; owner: ScenePrimitiveOwner; camera: SceneCameraOwner; refs?: SceneReferenceRegistry }) =>
  new SceneGraphTransactionDriver(scope.graph, {
    sceneId, transactionId: plan.id, baseRevision: plan.baseRevision, parser: { parse: parseSceneCommand },
    primitiveOwner: scope.owner, cameraPort: scope.camera, ...(scope.refs ? { referenceCleanup: scope.refs } : {}),
  });
const request = (id: string, base: SceneTransformGraph<string>, commands: unknown[]) => ({ id, sceneId, baseRevision: base.revision,
  module: { id: "hc7p3-owner-cli", capabilities: ["studio.object", "studio.material", "studio.camera"], permissions: ["scene.write"] }, commands });

const phase = async (name: string, commands: unknown[], scope = { graph, owner, camera, refs }) => {
  const prepared = prepareSceneCommandTransaction(request(name, scope.graph, commands));
  if (prepared.status !== "prepared") throw Error(`prepare rejected: ${JSON.stringify(prepared.issues)}`);
  const host = driver(prepared.plan, scope);
  const outcome = await commitSceneCommandTransaction(prepared.plan, host);
  if (outcome.status !== "committed") throw Error(`commit ${name}: ${outcome.status} ${JSON.stringify(outcome.issue)}`);
  const finalFlush = host.finalFlush as SceneTransformFlushResult<string>;
  spatial.apply(finalFlush);
  return { receipt: outcome.receipt, finalFlush };
};

// 阶段 1:author——三图元(移动+材质+隐藏)+ 引用容器 + 相机 set + fly-to,单事务。
const authorPhase = await phase("author", [
  { id: "create-re", type: "object.create-primitive", target: { kind: "object", sceneId, objectId: "re-box" }, name: "re", kind: "box", color: "#1683ff" },
  { id: "move-re", type: "object.set-transform", target: { kind: "object", sceneId, objectId: "re-box" },
    position: [3, 0, 0], rotation: [0.3, 0.8, -0.4], scale: [2, 0.5, 1.5] },
  { id: "material-re", type: "material.set", target: { kind: "object", sceneId, objectId: "re-box" },
    patch: { color: "#ff8800", metalness: 0.8, roughness: 0.25 } },
  { id: "create-victim", type: "object.create-primitive", target: { kind: "object", sceneId, objectId: "victim-box" }, name: "victim", kind: "cylinder", color: "#ff8844" },
  { id: "create-hidden", type: "object.create-primitive", target: { kind: "object", sceneId, objectId: "hidden-box" }, name: "hidden", kind: "sphere", color: "#00ff00" },
  { id: "hide-hidden", type: "object.set-visibility", target: { kind: "object", sceneId, objectId: "hidden-box" }, visible: false },
  { id: "camera-set", type: "camera.set", sceneId, position: [10, 8, 6], target: [0, 0, 0], near: 0.5, far: 500, fov: 55 },
  { id: "camera-fly", type: "camera.fly-to", sceneId, target: { kind: "object", sceneId, objectId: "re-box" }, durationMs: 0 },
]);
const authorCamera = camera.snapshot();
if (authorCamera.pose!.target[0] !== 3) throw Error(`fly-to focus projection unexpected: ${JSON.stringify(authorCamera.pose)}`);

// 阶段 2:snapshot——导出 SceneSnapshot(相机/引用容器随宿主补充)+ JSON 真实序列化往返。
const savedSnapshot: SceneSnapshot = owner.snapshotScene();
const pose = authorCamera.pose!;
savedSnapshot.camera = { position: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
  target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] }, mode: "orbit" };
savedSnapshot.selectionSets = refs.state.selectionSets;
savedSnapshot.rootLayerOrder = refs.state.rootLayerOrder;
const serialized = JSON.stringify(savedSnapshot);
const reopenedSnapshot = JSON.parse(serialized) as SceneSnapshot;
if (reopenedSnapshot.primitives.length !== 3) throw Error(`snapshot roundtrip lost primitives: ${reopenedSnapshot.primitives.length}`);

// 阶段 3:reopen——水合新 owner/graph + 相机/引用 port 接回。
const reopened = restoreSceneFromSnapshot({ snapshot: reopenedSnapshot, sceneId });
const reopenRefs = new SceneReferenceRegistry({ sceneId, containers: {
  selectionSets: reopened.snapshot.selectionSets ?? [], rootLayerOrder: reopened.snapshot.rootLayerOrder ?? [],
} });
const reopenCamera = new SceneCameraOwner({ sceneId });
reopenCamera.setCamera({ position: [reopenedSnapshot.camera.position.x, reopenedSnapshot.camera.position.y, reopenedSnapshot.camera.position.z],
  target: [reopenedSnapshot.camera.target.x, reopenedSnapshot.camera.target.y, reopenedSnapshot.camera.target.z] });
const hashSaved = owner.compileRuntimePackage({ packageId: "scene.owner-reopen-pkg", revision: 42 }).runtimePackage.packageHash.value;
const hashReopened = reopened.owner.compileRuntimePackage({ packageId: "scene.owner-reopen-pkg", revision: 42 }).runtimePackage.packageHash.value;
if (hashReopened !== hashSaved) throw Error(`reopened package hash drifted: ${hashReopened} vs ${hashSaved}`);
const restoredRe = reopened.owner.get("re-box");
if (!restoredRe || restoredRe.transform.position.x !== 3 || restoredRe.material?.metalness !== 0.8) throw Error("reopened re-box state drifted");
if (reopened.graph.getNode("hidden-box")!.hidden !== true) throw Error("reopened hidden state drifted");
if (reopenRefs.state.selectionSets[0]!.objectIds.join(",") !== "re-box,victim-box") throw Error("reopened references drifted");

// 阶段 4:post-reopen——重开场景继续作者:set-transform + delete 引用图元 + fly-to,引用清理消费。
const postPhase = await phase("post-reopen", [
  { id: "move-again", type: "object.set-transform", target: { kind: "object", sceneId, objectId: "re-box" }, position: [9, 1, 0] },
  { id: "delete-victim", type: "object.delete-primitive", target: { kind: "object", sceneId, objectId: "victim-box" } },
  { id: "fly-again", type: "camera.fly-to", sceneId, target: { kind: "object", sceneId, objectId: "re-box" }, durationMs: 0 },
], { graph: reopened.graph, owner: reopened.owner, camera: reopenCamera, refs: reopenRefs });
const postFlush = postPhase.finalFlush;
const removedPost = [...postFlush.removedNodeIds];
if (JSON.stringify(removedPost) !== JSON.stringify(["victim-box"])) throw Error(`post-reopen removed unexpected: ${JSON.stringify(removedPost)}`);
if (reopenRefs.state.selectionSets[0]!.objectIds.join(",") !== "re-box") throw Error(`post-reopen selection set not pruned: ${JSON.stringify(reopenRefs.state.selectionSets)}`);
if (JSON.stringify(reopenRefs.state.rootLayerOrder) !== JSON.stringify([{ kind: "object", id: "re-box" }, { kind: "object", id: "hidden-box" }])) {
  throw Error(`post-reopen rootLayerOrder not pruned: ${JSON.stringify(reopenRefs.state.rootLayerOrder)}`);
}
const postPacket = reopened.owner.compileRuntimePackage({ packageId: "scene.owner-reopen-pkg", revision: reopened.graph.revision });
const postPayload = postPacket.runtimePackage.payloads["scene.render"] as Record<string, unknown>;
const postInstances = postPayload.instances as Array<Record<string, unknown>>;
if (JSON.stringify(postInstances.map(entry => entry.id)) !== JSON.stringify(["re-box"])) throw Error("post-reopen packet instances unexpected");
if (postInstances[0]!.transform !== undefined && Math.abs((postInstances[0]!.transform as number[])[12]! - 9) > 1e-6) throw Error("post-reopen projection drifted");
const hashPost = postPacket.runtimePackage.packageHash.value;
if (hashPost === hashReopened) throw Error("post-reopen package hash should change after delete");
const reopenedCameraSnapshot = reopenCamera.snapshot();
if (reopenedCameraSnapshot.pose!.target[0] !== 9) throw Error(`post-reopen fly-to projection unexpected: ${JSON.stringify(reopenedCameraSnapshot.pose)}`);

const receipt: Record<string, unknown> = {
  sceneId, schema: "hc7p3-graph-owner-save-reopen/1",
  phases: [
    { phase: "author", receipt: authorPhase.receipt, finalFlush: {
        revision: authorPhase.finalFlush.revision, changedNodeIds: authorPhase.finalFlush.changedNodeIds, removedNodeIds: authorPhase.finalFlush.removedNodeIds },
      commandTypes: ["object.create-primitive", "object.set-transform", "material.set", "object.set-visibility", "camera.set", "camera.fly-to"],
      camera: { poseAfterFlyTo: authorCamera.pose, lastIntent: authorCamera.lastIntent } },
    { phase: "snapshot", schemaVersion: savedSnapshot.schemaVersion, primitiveCount: reopenedSnapshot.primitives.length,
      serializedBytes: serialized.length,
      persisted: { camera: savedSnapshot.camera, selectionSets: savedSnapshot.selectionSets, rootLayerOrder: savedSnapshot.rootLayerOrder },
      primitiveKinds: reopenedSnapshot.primitives.map(primitive => ({ modelId: primitive.modelId, kind: primitive.kind, visible: primitive.visible })) },
    { phase: "reopen", reopenedNodeCount: reopened.graph.size, reopenedPrimitiveCount: reopened.owner.list().length,
      packageHashSaved: hashSaved, packageHashReopened: hashReopened, packageHashIdentical: hashReopened === hashSaved,
      cameraPoseRestored: reopenCamera.snapshot().pose, referencesRestored: reopenRefs.state.selectionSets },
    { phase: "post-reopen", receipt: postPhase.receipt, finalFlush: {
        revision: postFlush.revision, changedNodeIds: postFlush.changedNodeIds, removedNodeIds: postFlush.removedNodeIds },
      referenceCleanup: { selectionSetsAfter: reopenRefs.state.selectionSets, rootLayerOrderAfter: reopenRefs.state.rootLayerOrder },
      camera: { poseAfterFlyTo: reopenedCameraSnapshot.pose },
      runtimePackage: { packageHash: hashPost, packageHashChanged: hashPost !== hashReopened,
        instances: postInstances.map(entry => entry.id),
        geometryIds: (postPayload.geometries as Array<{ id: string }>).map(entry => entry.id) } },
  ],
  final: {
    graphRevision: reopened.graph.revision, graphNodeCount: reopened.graph.size,
    ownerRegistry: reopened.owner.list().map(primitive => ({ modelId: primitive.modelId, kind: primitive.kind,
      color: primitive.color, visible: primitive.visible, material: primitive.material ?? null })),
    roundtripProven: hashReopened === hashSaved,
    referenceCleanupProven: reopenRefs.state.selectionSets[0]!.objectIds.join(",") === "re-box",
    cameraConsumedProven: reopenedCameraSnapshot.pose!.target[0] === 9 && authorCamera.pose!.target[0] === 3,
  },
};
const json = JSON.stringify(receipt, null, 2) + "\n";
if (outPath) await fs.writeFile(outPath, json);
console.log(json);
