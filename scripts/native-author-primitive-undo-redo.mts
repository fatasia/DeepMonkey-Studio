import fs from "node:fs/promises";
import { SceneTransformGraph, SceneTransformSpatialBridge, type SceneTransformFlushResult } from "../packages/deep-engine/src/scene/index.js";
import { LooseOctreeIndex } from "../packages/deep-engine/src/spatial/index.js";
import { prepareSceneCommandTransaction, commitSceneCommandTransaction, parseSceneCommand, type SceneCommandTransactionOutcome } from "../packages/scene-sdk/src/index.js";
import { SceneGraphTransactionDriver } from "../apps/web/src/commands/SceneGraphTransactionDriver.js";
import { ScenePrimitiveOwner } from "../apps/web/src/commands/ScenePrimitiveOwnerPort.js";
import { SceneGraphHistoryBridge, type SceneGraphHistoryRestoreResult } from "../apps/web/src/commands/SceneGraphHistoryBridge.js";
import { SceneReferenceRegistry } from "../apps/web/src/commands/SceneReferenceCleanupPort.js";

// H-C7-P3 第四批 CLI:撤销轮(宿主 Ctrl+Z 链)。
// 1) create:桥事务窗口内 [create undo-box + set-transform + material.set] committed → 恰落一条撤销条目;
// 2) undo:宿主撤销 → 图元消失(graph/注册表)+ 资源释放 + 重水合 flush 重建的 octree 清空 + 包投影零实例;
// 3) redo:重做 → 图元恢复(权威变换/材质),包哈希与撤销前逐字节一致(同 revision 编译输入);
// 4) delete 轮:引用清理删除 committed(选择集/根序摘除)→ undo 恢复图元+引用 → redo 再删再摘。
// receipt 落盘 test-output/hc7p3-graph-owner-20261002/cli-undo-redo-receipt.json。
const args = process.argv.slice(2);
const value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const sceneId = value("--scene") ?? "native-author";
const outPath = value("--out");

const graph = new SceneTransformGraph<string>();
graph.flush();
const owner = new ScenePrimitiveOwner({ sceneId });
const refs = new SceneReferenceRegistry({ sceneId, containers: {
  selectionSets: [{ id: "g1", name: "撤销组", objectIds: ["undo-box"] }],
  rootLayerOrder: [{ kind: "object", id: "undo-box" }],
} });
const bridge = new SceneGraphHistoryBridge({ owner, graph, references: refs }, { sceneId });

const author = async (label: string, transactionId: string, commands: unknown[], capabilities: readonly string[] = ["studio.object", "studio.material"]): Promise<SceneCommandTransactionOutcome> =>
  bridge.edit(label, async () => {
    const runtimeGraph = bridge.runtime.graph;
    const runtimeOwner = bridge.runtime.owner;
    const prepared = prepareSceneCommandTransaction({
      id: transactionId, sceneId, baseRevision: runtimeGraph.revision,
      module: { id: "hc7p3-owner-cli", capabilities: [...capabilities] as never, permissions: ["scene.write"] }, commands,
    });
    if (prepared.status !== "prepared") throw Error(`prepare rejected: ${JSON.stringify(prepared.issues)}`);
    const host = new SceneGraphTransactionDriver(runtimeGraph, {
      sceneId, transactionId: prepared.plan.id, baseRevision: prepared.plan.baseRevision, parser: { parse: parseSceneCommand },
      primitiveOwner: runtimeOwner, referenceCleanup: refs,
    });
    return commitSceneCommandTransaction(prepared.plan, host);
  });

/** 重水合 flush → 全新 octree(换装后世界态真值)+ 查询取 ID 串。 */
const spatialIds = (flush: SceneTransformFlushResult<string>, min: number[], max: number[]): string => {
  const index = new LooseOctreeIndex<string>({ bounds: { min: [-1_000_000, -1_000_000, -1_000_000], max: [1_000_000, 1_000_000, 1_000_000] } });
  new SceneTransformSpatialBridge({ kind: "octree", target: index }).apply(flush);
  const ids = index.queryAabb({ min: min as [number, number, number], max: max as [number, number, number] }).ids;
  return ids.length ? ids.join(",") : "(empty)";
};
const hashOf = (scope: { owner: ScenePrimitiveOwner }, revision: number) =>
  scope.owner.compileRuntimePackage({ packageId: "scene.undo-redo-pkg", revision }).runtimePackage.packageHash.value;
const assertEq = (actual: unknown, expected: unknown, message: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
};

// 阶段 1:create——桥事务窗口内创建+移动+材质,committed 后恰落一条撤销条目。
const createOutcome = await author("创建图元", "tx:undo-create", [
  { id: "create-box", type: "object.create-primitive", target: { kind: "object", sceneId, objectId: "undo-box" }, name: "box", kind: "box", color: "#1683ff" },
  { id: "move-box", type: "object.set-transform", target: { kind: "object", sceneId, objectId: "undo-box" }, position: [3, 0, 0] },
  { id: "material-box", type: "material.set", target: { kind: "object", sceneId, objectId: "undo-box" }, patch: { color: "#ff8800", metalness: 0.8, roughness: 0.25 } },
]);
if (createOutcome.status !== "committed") throw Error(`create: ${createOutcome.status}`);
const stateAfterCreate = bridge.state();
assertEq([stateAfterCreate.canUndo, stateAfterCreate.undoLabel, stateAfterCreate.canRedo], [true, "创建图元", false], "create history state");
const hashAfterCreate = hashOf(bridge.runtime, 42);
assertEq(bridge.runtime.owner.list().length, 1, "create registry size");

// 阶段 2:undo——图元消失、资源释放、空间清空、包投影零实例。
const undone: SceneGraphHistoryRestoreResult = bridge.undo()!;
const stateAfterUndo = bridge.state();
const spatialAfterUndo = spatialIds(undone.flush, [-10, -10, -10], [10, 10, 10]);
assertEq(stateAfterUndo.canRedo, true, "undo enables redo");
assertEq(undone.runtime.owner.has("undo-box"), false, "undo released primitive from registry");
assertEq(undone.runtime.graph.has("undo-box"), false, "undo removed graph node");
assertEq(spatialAfterUndo, "(empty)", "undo cleared spatial index");
assertEq(undone.runtime.owner.compileRuntimePackage({ packageId: "scene.undo-redo-pkg", revision: 42 }).renderPacket.instances.length, 0, "undo package instances");

// 阶段 3:redo——图元带权威变换/材质恢复,包哈希与撤销前逐字节一致。
const redone: SceneGraphHistoryRestoreResult = bridge.redo()!;
const stateAfterRedo = bridge.state();
const spatialAfterRedo = spatialIds(redone.flush, [1, -2, -2], [5, 2, 2]);
const redoTransformX = redone.runtime.owner.get("undo-box")!.transform.position.x;
const redoMetalness = redone.runtime.owner.get("undo-box")!.material!.metalness;
assertEq(redoTransformX, 3, "redo restored transform");
assertEq(redoMetalness, 0.8, "redo restored material");
assertEq(redone.runtime.graph.getNode("undo-box")!.worldMatrix[12], 3, "redo restored world matrix");
assertEq(spatialAfterRedo, "undo-box", "redo restored spatial index");
const hashAfterRedo = hashOf(bridge.runtime, 42);
assertEq(hashAfterRedo, hashAfterCreate, "redo package hash byte-identical to pre-undo");

// 阶段 4:delete 轮——引用清理删除 committed → undo 恢复图元+引用 → redo 再删再摘。
const deleteOutcome = await author("删除图元", "tx:undo-delete", [
  { id: "delete-box", type: "object.delete-primitive", target: { kind: "object", sceneId, objectId: "undo-box" } },
]);
if (deleteOutcome.status !== "committed") throw Error(`delete: ${deleteOutcome.status}`);
assertEq(refs.state.selectionSets[0]!.objectIds, [], "delete pruned selection set");
assertEq(refs.state.rootLayerOrder, [], "delete pruned rootLayerOrder");
assertEq(bridge.runtime.owner.has("undo-box"), false, "delete released ownership");
const stateAfterDelete = bridge.state();
assertEq(stateAfterDelete.undoLabel, "删除图元", "delete entry label");
const deleteUndone = bridge.undo()!;
const stateAfterDeleteUndo = bridge.state();
const spatialAfterDeleteUndo = spatialIds(deleteUndone.flush, [1, -2, -2], [5, 2, 2]);
const deleteUndoTransformX = deleteUndone.runtime.owner.get("undo-box")!.transform.position.x;
assertEq(deleteUndoTransformX, 3, "delete-undo restored transform");
assertEq(refs.state.selectionSets[0]!.objectIds, ["undo-box"], "delete-undo restored selection set");
assertEq(refs.state.rootLayerOrder, [{ kind: "object", id: "undo-box" }], "delete-undo restored rootLayerOrder");
assertEq(spatialAfterDeleteUndo, "undo-box", "delete-undo restored spatial index");
const deleteRedone = bridge.redo()!;
const stateAfterDeleteRedo = bridge.state();
assertEq(deleteRedone.runtime.owner.has("undo-box"), false, "delete-redo re-released ownership");
assertEq(refs.state.selectionSets[0]!.objectIds, [], "delete-redo re-pruned selection set");

const stateFinal = bridge.state();
const undoRedoProven = hashAfterRedo === hashAfterCreate
  && bridge.runtime.owner.list().length === 0
  && refs.state.selectionSets[0]!.objectIds.length === 0;
if (!undoRedoProven) throw Error("undo/redo round failed its final assertions");

const receipt: Record<string, unknown> = {
  sceneId,
  schema: "hc7p3-graph-owner-undo-redo/1",
  phases: [
    { phase: "create", receipt: createOutcome.receipt, history: stateAfterCreate,
      packageHash: hashAfterCreate, registrySize: 1 },
    { phase: "undo-of-create", history: stateAfterUndo, registrySize: 0,
      graphHasPrimitive: false, spatialQueryNearOrigin: spatialAfterUndo,
      packageInstances: 0, resourcesReleased: true },
    { phase: "redo-of-create", history: stateAfterRedo,
      transformX: redoTransformX, metalness: redoMetalness,
      spatialQueryNearBox: spatialAfterRedo,
      packageHash: hashAfterRedo, packageHashByteIdentical: hashAfterRedo === hashAfterCreate },
    { phase: "delete", receipt: deleteOutcome.receipt, history: stateAfterDelete,
      selectionSetsAfter: refs.state.selectionSets, rootLayerOrderAfter: refs.state.rootLayerOrder },
    { phase: "undo-of-delete", history: stateAfterDeleteUndo,
      transformX: deleteUndoTransformX,
      spatialQueryNearBox: spatialAfterDeleteUndo,
      selectionSetsAfter: refs.state.selectionSets, rootLayerOrderAfter: refs.state.rootLayerOrder },
    { phase: "redo-of-delete", history: stateAfterDeleteRedo,
      registrySize: bridge.runtime.owner.list().length,
      selectionSetsAfter: refs.state.selectionSets },
  ],
  final: {
    graphRevision: bridge.runtime.graph.revision, graphNodeCount: bridge.runtime.graph.size,
    history: stateFinal,
    undoRedoProven,
  },
};
const json = JSON.stringify(receipt, null, 2) + "\n";
if (outPath) await fs.writeFile(outPath, json);
console.log(json);
