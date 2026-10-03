import fs from "node:fs/promises";
import { SceneTransformGraph, SceneTransformSpatialBridge, type SceneTransformFlushResult } from "../packages/deep-engine/src/scene/index.js";
import { LooseOctreeIndex } from "../packages/deep-engine/src/spatial/index.js";
import { prepareSceneCommandTransaction, commitSceneCommandTransaction, parseSceneCommand, type SceneCommandTransactionPlan } from "../packages/scene-sdk/src/index.js";
import { SceneGraphTransactionDriver } from "../apps/web/src/commands/SceneGraphTransactionDriver.js";
import { ScenePrimitiveOwner } from "../apps/web/src/commands/ScenePrimitiveOwnerPort.js";
import { SceneReferenceRegistry } from "../apps/web/src/commands/SceneReferenceCleanupPort.js";
import type { SceneAssetBindingState } from "../packages/contracts/src/index.js";

// H-C7-P3 第五批 CLI:assetBindings 拒绝/清理两路。
// 1) author:pump-box + valve-box 双图元 + 引用容器(pump 双绑定/valve 单绑定)单事务 committed;
// 2) reject:删除 pump-box → 整批拒绝,错误列出全部命中绑定 id,引用/图元/节点零变更;
// 3) unbind+delete:宿主显式解绑(removeAssetBindingsFor 返回深拷贝)→ 删除 committed,
//    selectionSets/rootLayerOrder 摘引用,valve 绑定不受牵连,包实例跟随;
// 4) bound-bystander-reject:valve 仍被绑定,删除再次拒绝并列出其绑定 id。
// receipt 落盘 test-output/hc7p3-graph-owner-20261002/cli-asset-binding-receipt.json。
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const sceneId = value("--scene") ?? "native-author";
const outPath = value("--out");

const graph = new SceneTransformGraph<string>();
graph.flush();
const owner = new ScenePrimitiveOwner({ sceneId });
const refs = new SceneReferenceRegistry({ sceneId, containers: {
  selectionSets: [{ id: "g1", name: "机组 A", objectIds: ["pump-box", "valve-box"] }],
  rootLayerOrder: [{ kind: "object", id: "pump-box" }, { kind: "object", id: "valve-box" }],
  assetBindings: [
    bindingOf("asset-pump-1", "pump-box", "pump-01"),
    bindingOf("asset-pump-2", "pump-box", "pump-02"),
    bindingOf("asset-valve-1", "valve-box", "valve-01"),
  ],
} });
const index = new LooseOctreeIndex<string>({ bounds: { min: [-1_000_000, -1_000_000, -1_000_000], max: [1_000_000, 1_000_000, 1_000_000] } });
const spatial = new SceneTransformSpatialBridge({ kind: "octree", target: index });

function bindingOf(id: string, objectId: string, deviceId: string): SceneAssetBindingState {
  return { id, sceneObjectId: objectId, objectName: objectId, modelId: objectId, deviceId, confidence: 1, confirmedAt: "2026-10-02T00:00:00.000Z" };
}

const driver = (plan: SceneCommandTransactionPlan) =>
  new SceneGraphTransactionDriver(graph, {
    sceneId, transactionId: plan.id, baseRevision: plan.baseRevision, parser: { parse: parseSceneCommand },
    primitiveOwner: owner, referenceCleanup: refs,
  });
const request = (id: string, commands: unknown[]) => ({ id, sceneId, baseRevision: graph.revision,
  module: { id: "hc7p3-owner-cli", capabilities: ["studio.object"], permissions: ["scene.write"] }, commands });
const obj = (objectId: string) => ({ kind: "object" as const, sceneId, objectId });

async function phase(name: string, commands: unknown[]) {
  const prepared = prepareSceneCommandTransaction(request(name, commands));
  if (prepared.status !== "prepared") throw Error(`prepare rejected: ${JSON.stringify(prepared.issues)}`);
  const host = driver(prepared.plan);
  const outcome = await commitSceneCommandTransaction(prepared.plan, host);
  return { outcome, host, plan: prepared.plan };
}

// 阶段 1:author——双图元单事务。
const author = await phase("author", [
  { id: "create-pump", type: "object.create-primitive", target: obj("pump-box"), name: "pump", kind: "cylinder", color: "#1683ff" },
  { id: "create-valve", type: "object.create-primitive", target: obj("valve-box"), name: "valve", kind: "sphere", color: "#ff8844" },
]);
if (author.outcome.status !== "committed") throw Error(`author: ${author.outcome.status}`);
spatial.apply(author.host.finalFlush as SceneTransformFlushResult<string>);

// 阶段 2:reject——删除被绑定图元,整批拒绝并列出全部命中绑定 id;零变更。
const rejectPlan = prepareSceneCommandTransaction(request("reject", [{ id: "del-pump", type: "object.delete-primitive", target: obj("pump-box") }]));
if (rejectPlan.status !== "prepared") throw Error("reject prepare failed");
let rejectError = "";
try { driver(rejectPlan.plan).apply(rejectPlan.plan.commands); }
catch (error) { rejectError = error instanceof Error ? error.message : String(error); }
if (!/asset-pump-1、asset-pump-2/.test(rejectError)) throw Error(`reject did not list both bound ids: ${rejectError}`);
const zeroMutation = owner.has("pump-box") && graph.has("pump-box")
  && JSON.stringify(refs.state.selectionSets[0]!.objectIds) === JSON.stringify(["pump-box", "valve-box"])
  && refs.state.assetBindings!.length === 3;
if (!zeroMutation) throw Error("reject mutated state");

// 阶段 3:unbind + delete——宿主显式解绑(清理路),删除照常消费。
const removedBindings = refs.removeAssetBindingsFor("pump-box");
if (removedBindings.length !== 2) throw Error(`unbind removed unexpected count: ${removedBindings.length}`);
const cleanup = await phase("cleanup-delete", [{ id: "del-pump-2", type: "object.delete-primitive", target: obj("pump-box") }]);
if (cleanup.outcome.status !== "committed") throw Error(`cleanup delete: ${cleanup.outcome.status}`);
spatial.apply(cleanup.host.finalFlush as SceneTransformFlushResult<string>);
if (owner.has("pump-box") || graph.has("pump-box")) throw Error("cleanup delete did not release ownership");
if (JSON.stringify(refs.state.selectionSets[0]!.objectIds) !== JSON.stringify(["valve-box"])) throw Error("selection set not pruned");
if (JSON.stringify(refs.state.rootLayerOrder) !== JSON.stringify([{ kind: "object", id: "valve-box" }])) throw Error("rootLayerOrder not filtered");
if (refs.state.assetBindings!.length !== 1 || refs.state.assetBindings![0]!.id !== "asset-valve-1") throw Error("valve binding disturbed");
const packet = owner.compileRuntimePackage({ packageId: "scene.owner-binding-pkg", revision: graph.revision });
const payload = packet.runtimePackage.payloads["scene.render"] as Record<string, unknown>;
const instances = (payload.instances as Array<Record<string, unknown>>).map(entry => entry.id);
if (JSON.stringify(instances) !== JSON.stringify(["valve-box"])) throw Error(`packet instances unexpected: ${JSON.stringify(instances)}`);
if (JSON.stringify(index.queryAabb({ min: [-2, -2, -2], max: [2, 2, 2] }).ids) !== JSON.stringify(["valve-box"])) throw Error("spatial index not updated");

// 阶段 4:bound-bystander-reject——valve 仍被绑定,删除再次拒绝并列出其绑定 id。
const valvePlan = prepareSceneCommandTransaction(request("reject-valve", [{ id: "del-valve", type: "object.delete-primitive", target: obj("valve-box") }]));
if (valvePlan.status !== "prepared") throw Error("valve prepare failed");
let valveError = "";
try { driver(valvePlan.plan).apply(valvePlan.plan.commands); }
catch (error) { valveError = error instanceof Error ? error.message : String(error); }
if (!/asset-valve-1/.test(valveError)) throw Error(`valve reject did not list binding id: ${valveError}`);
if (!owner.has("valve-box") || !graph.has("valve-box")) throw Error("valve reject mutated state");

const receipt: Record<string, unknown> = {
  sceneId, schema: "hc7p3-graph-owner-asset-binding/1",
  phases: [
    { phase: "author", receipt: author.outcome.receipt, finalFlush: {
        revision: author.host.finalFlush!.revision, changedNodeIds: author.host.finalFlush!.changedNodeIds },
      bindingsSeeded: ["asset-pump-1", "asset-pump-2", "asset-valve-1"] },
    { phase: "reject", refused: true, error: rejectError, listedBindingIds: ["asset-pump-1", "asset-pump-2"],
      zeroMutationProven: zeroMutation,
      stateAfter: { ownerHasPump: owner.has("pump-box"), selectionSets: refs.state.selectionSets, assetBindingCount: refs.state.assetBindings!.length } },
    { phase: "unbind", removedBindings, remainingBindingIds: refs.state.assetBindings!.map(entry => entry.id) },
    { phase: "cleanup-delete", receipt: cleanup.outcome.receipt, finalFlush: {
        revision: cleanup.host.finalFlush!.revision, removedNodeIds: cleanup.host.finalFlush!.removedNodeIds },
      referenceCleanup: { selectionSetsAfter: refs.state.selectionSets, rootLayerOrderAfter: refs.state.rootLayerOrder,
        assetBindingsAfter: refs.state.assetBindings },
      runtimePackage: { packageHash: packet.runtimePackage.packageHash.value, instances,
        geometryIds: (payload.geometries as Array<{ id: string }>).map(entry => entry.id) },
      spatialNearValve: index.queryAabb({ min: [-2, -2, -2], max: [2, 2, 2] }).ids },
    { phase: "bound-bystander-reject", refused: true, error: valveError, listedBindingIds: ["asset-valve-1"],
      zeroMutationProven: owner.has("valve-box") && graph.has("valve-box") },
  ],
  final: {
    graphRevision: graph.revision, graphNodeCount: graph.size,
    ownerRegistry: owner.list().map(primitive => ({ modelId: primitive.modelId, kind: primitive.kind, color: primitive.color })),
    assetBindingRejectProven: /asset-pump-1、asset-pump-2/.test(rejectError) && /asset-valve-1/.test(valveError) && zeroMutation,
    assetBindingCleanupProven: !owner.has("pump-box") && removedBindings.length === 2
      && refs.state.assetBindings!.length === 1 && JSON.stringify(instances) === JSON.stringify(["valve-box"]),
  },
};
const json = JSON.stringify(receipt, null, 2) + "\n";
if (outPath) await fs.writeFile(outPath, json);
console.log(json);
