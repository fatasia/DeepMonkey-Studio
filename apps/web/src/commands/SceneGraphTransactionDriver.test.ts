import { it } from "vitest";
import assert from "node:assert/strict";
import { SceneTransformGraph } from "@bim-studio/deep-engine/scene";
import { SceneTransformSpatialBridge } from "@bim-studio/deep-engine/scene";
import type { SceneTransformFlushResult } from "@bim-studio/deep-engine/scene";
import { LooseOctreeIndex } from "@bim-studio/deep-engine";
import { SceneGraphTransactionDriver } from "./SceneGraphTransactionDriver";
import { ScenePrimitiveOwner, primitiveStateFromCommand } from "./ScenePrimitiveOwnerPort";
import { SceneGraphHistoryBridge } from "./SceneGraphHistoryBridge";
import { SceneCameraOwner } from "./SceneCameraPort";
import { SceneReferenceRegistry } from "./SceneReferenceCleanupPort";
import { commitSceneCommandTransaction, prepareSceneCommandTransaction } from "@bim-studio/scene-sdk";
import { parseSceneCommand, validateSceneCommand } from "@bim-studio/scene-sdk";
import { SceneCommandExecutor } from "../behavior/SceneCommandExecutor";

const cases: string[]=[];
const transform=(x:number)=>({kind:"trs" as const,translation:[x,0,0] as const,rotation:[0,0,0,1] as const,scale:[1,1,1] as const});
const target=(id="child",sceneId="world")=>({kind:"object" as const,sceneId,objectId:id});
const parent=(parentId:string|null,keepWorldTransform=false,id="parent")=>({id,type:"object.set-parent",target:target(),parentId,keepWorldTransform});
const fixture=()=>{
 const graph=new SceneTransformGraph<string>();graph.create({id:"a",localTransform:transform(10)});graph.create({id:"b",localTransform:transform(-4)});
 graph.create({id:"child",parent:"a",localTransform:transform(2),localBounds:{min:[-1,-1,-1],max:[1,1,1]}});graph.flush();
 return graph;
};
function plan(graph:SceneTransformGraph<string>,commands:unknown[],capabilities:readonly string[]=["studio.object"]){
 const prepared=prepareSceneCommandTransaction({id:"tx:author",sceneId:"world",baseRevision:graph.revision,module:{id:"author",capabilities:[...capabilities] as never,permissions:["scene.write"]},commands});
 assert.equal(prepared.status,"prepared");if(prepared.status!=="prepared")throw Error("prepare failed");return prepared.plan;
}
function driver(graph:SceneTransformGraph<string>,transaction=plan(graph,[parent("b")])){
 return new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:transaction.id,baseRevision:transaction.baseRevision,parser:{parse:parseSceneCommand}});
}
it("safe object.set-parent command parsing", async () => {
assert.equal(validateSceneCommand(parent("b")).valid,true);
for(const invalid of [{...parent("b"),parentId:""},{...parent("b"),keepWorldTransform:1},{...parent("b"),target:{kind:"scene",sceneId:"world"}},{...parent("b"),target:{...target(),kind:"mesh",meshId:"face"}},{...parent("b"),unknown:true}])assert.equal(validateSceneCommand(invalid).valid,false);
let getterCalls=0;
const accessor={...parent("b")};
Object.defineProperty(accessor,"parentId",{get(){getterCalls++;return "b";},enumerable:true});
assert.equal(validateSceneCommand(accessor).valid,false);
assert.equal(getterCalls,0);
cases.push("existing safe validator rejects invalid/accessor payloads; preserves null and detached data");

});
it("SDK parent commit/keep-world/detach consumed by real graph+SpatialBridge+octree", async () => {

 const graph=fixture(), index=new LooseOctreeIndex<string>({bounds:{min:[-100,-100,-100],max:[100,100,100]}}),bridge=new SceneTransformSpatialBridge({kind:"octree",target:index});
 graph.update("child",{localBounds:{min:[-1,-1,-1],max:[1.01,1,1]}});bridge.apply(graph.flush());
 const tx=plan(graph,[parent("b",true)]),d=driver(graph,tx);const result=await commitSceneCommandTransaction(tx,d);assert.equal(result.status,"committed");assert.equal(graph.getNode("child")!.parent,"b");assert.equal(graph.getNode("child")!.worldMatrix[12],12);bridge.apply(d.finalFlush!);
 assert.deepEqual(index.queryAabb({min:[11,-1,-1],max:[13.01,1,1]}).ids,["child"]);
 const next=plan(graph,[parent(null,false,"detach")]),d2=driver(graph,next);assert.equal((await commitSceneCommandTransaction(next,d2)).status,"committed");bridge.apply(d2.finalFlush!);
 assert.equal(graph.getNode("child")!.worldMatrix[12],16);assert.deepEqual(index.queryAabb({min:[15,-1,-1],max:[17.01,1,1]}).ids,["child"]);
 cases.push("SDK parent commit/keep-world/detach consumed by real graph+SpatialBridge+octree");

});
it("ordered transform + hierarchy compose through existing gateway and graph", async () => {

 const graph=fixture(),tx=plan(graph,[{id:"move",type:"object.set-transform",target:target(),position:[3,0,0]},parent("b")]),d=driver(graph,tx);
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");assert.equal(graph.getNode("child")!.worldMatrix[12],-1);cases.push("ordered transform + hierarchy compose through existing gateway and graph");

});
it("late cycle rejects whole graph transaction without publishing a delta", async () => {

 const graph=fixture(),before=JSON.stringify(graph.getNode("child")),tx=plan(graph,[parent("b"),parent("child",false,"cycle")]),d=driver(graph,tx);
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"rolled-back");assert.equal(JSON.stringify(graph.getNode("child")),before);assert.equal(d.finalFlush,undefined);cases.push("late cycle rejects whole graph transaction without publishing a delta");

});
it("real SDK cancellation after apply restores original hierarchy/transform, rollback idempotent", async () => {

 const graph=fixture(),tx=plan(graph,[parent("b",true)]),d=driver(graph,tx),controller=new AbortController();
 const outcome=await commitSceneCommandTransaction(tx,{readRevision:()=>d.readRevision(),apply:commands=>{const applied=d.apply(commands);controller.abort();return applied;},rollback:()=>d.rollback()},controller.signal);
 assert.equal(outcome.status,"rolled-back");assert.equal(graph.getNode("child")!.parent,"a");assert.equal(graph.getNode("child")!.worldMatrix[12],12);const rev=d.rollback();assert.equal(rev,graph.revision);
 cases.push("real SDK cancellation after apply restores original hierarchy/transform, rollback idempotent");

});
it("cancel before apply and unflushed concurrent-generation change preserve graph", async () => {

 const graph=fixture(),tx=plan(graph,[parent("b")]),d=driver(graph,tx),controller=new AbortController();controller.abort();
 assert.equal((await commitSceneCommandTransaction(tx,d,controller.signal)).status,"rejected");assert.equal(graph.getNode("child")!.parent,"a");
 graph.update("a",{localTransform:transform(11)});assert.equal((await commitSceneCommandTransaction(tx,d)).status,"rolled-back");assert.equal(graph.getNode("child")!.parent,"a");
 cases.push("cancel before apply and unflushed concurrent-generation change preserve graph");

});
it("rollback refuses to overwrite concurrent unflushed edits", async () => {

 const graph=fixture(),tx=plan(graph,[parent("b")]),d=driver(graph,tx);d.apply(tx.commands);graph.update("a",{localTransform:transform(99)});
 assert.throws(()=>d.rollback(),/newer scene state/);assert.equal(graph.getNode("a")!.worldMatrix[12],99);cases.push("rollback refuses to overwrite concurrent unflushed edits");

});
it("same-scene/permission gates and detached command plan reuse SDK", async () => {

 const graph=fixture(),request={id:"tx",sceneId:"world",baseRevision:graph.revision,module:{id:"author",capabilities:["studio.object" as const],permissions:["scene.write" as const]},commands:[{...parent("b"),target:target("child","other")}]};
 assert.equal(prepareSceneCommandTransaction(request).status,"rejected");assert.equal(prepareSceneCommandTransaction({...request,commands:[parent("b")],module:{...request.module,permissions:[]}}).status,"rejected");
 const input=parent("b"),tx=plan(graph,[input]);input.parentId="a";assert.equal((tx.commands[0] as typeof input).parentId,"b");cases.push("same-scene/permission gates and detached command plan reuse SDK");

});
it("real existing Web executor reports unsupported hierarchy and scene mismatch without touching Viewer", async () => {

 const port=new Proxy({},{get(){throw Error("Existing Viewer port must not be invoked for unsupported hierarchy.");}});
 const executor=new SceneCommandExecutor("world",port as never),results=await executor.execute([parseSceneCommand(parent("b"))]);
 assert.equal(results[0]!.success,false);assert.equal(results[0]!.code,"unsupported");
 const wrong=await executor.execute([parseSceneCommand({...parent("b"),target:target("child","other")})]);assert.equal(wrong[0]!.success,false);assert.equal(wrong[0]!.code,"scene-mismatch");
 cases.push("real existing Web executor reports unsupported hierarchy and scene mismatch without touching Viewer");

});
it("mirrored nonuniform rotated parent preserves world matrix and inverse hierarchy", async () => {

 const graph=fixture();graph.update("a",{localTransform:{kind:"trs",translation:[10,2,3],rotation:[0,Math.sin(.2),0,Math.cos(.2)],scale:[-2,3,.5]}});graph.flush();
 const original=graph.getNode("child")!.worldMatrix,tx=plan(graph,[parent("b",true)]),d=driver(graph,tx);
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");const current=graph.getNode("child")!.worldMatrix;assert.equal(Math.max(...current.map((v,i)=>Math.abs(v-original[i]!))),0);
 d.rollback();assert.equal(graph.getNode("child")!.parent,"a");assert.deepEqual(graph.getNode("child")!.worldMatrix,original);cases.push("mirrored nonuniform rotated parent preserves world matrix and inverse hierarchy");

});
it("singular keep-world parent rejects atomically through real graph contract", async () => {

 const graph=fixture();graph.update("b",{localTransform:{...transform(-4),scale:[0,1,1]}});graph.flush();const original=graph.getNode("child")!,tx=plan(graph,[parent("b",true)]),d=driver(graph,tx);
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"rolled-back");assert.deepEqual(graph.getNode("child"),original);cases.push("singular keep-world parent rejects atomically through real graph contract");

});
/* ===== H-C7-P3 第四批:撤销栈对齐(SceneGraphHistoryBridge × SceneAuthoringHistory) ===== */

/** 撤销轮作者助手:开启桥事务窗口 → graph driver 提交 → committed 才落一条撤销条目。 */
const authorViaBridge = async (
  bridge: SceneGraphHistoryBridge,
  label: string,
  commands: unknown[],
  options: { capabilities?: readonly string[]; referenceCleanup?: SceneReferenceRegistry; cameraPort?: SceneCameraOwner } = {},
) => bridge.edit(label, async () => {
  const graph = bridge.runtime.graph;
  const owner = bridge.runtime.owner;
  const tx = plan(graph, commands, options.capabilities ?? ["studio.object"]);
  const d = new SceneGraphTransactionDriver(graph, {
    sceneId: "world", transactionId: tx.id, baseRevision: tx.baseRevision, parser: { parse: parseSceneCommand },
    primitiveOwner: owner,
    ...(options.cameraPort ? { cameraPort: options.cameraPort } : {}),
    ...(options.referenceCleanup ? { referenceCleanup: options.referenceCleanup } : {}),
  });
  return commitSceneCommandTransaction(tx, d);
});

/** 重水合 flush → 全新空间索引(撤销/重做换装后的世界态真值)。 */
const spatialOf = (flush: SceneTransformFlushResult<string>) => {
  const index = new LooseOctreeIndex<string>({ bounds: { min: [-1000, -1000, -1000], max: [1000, 1000, 1000] } });
  new SceneTransformSpatialBridge({ kind: "octree", target: index }).apply(flush);
  return index;
};

/** 图元态与 graph 节点同位构造(撤销重水合后世界位保持)。 */
const primitiveAt = (id: string, x: number, color: string) => ({
  ...primitiveStateFromCommand({ target: target(id), name: id, kind: "box" as const, color }),
  transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
});

it("H-C7-P4 history bridge: committed port create lands one undo entry; host undo releases resources and redo restores byte-identically", async () => {

 const bridge = new SceneGraphHistoryBridge(
  { owner: new ScenePrimitiveOwner({ sceneId: "world" }), graph: new SceneTransformGraph<string>(),
    references: new SceneReferenceRegistry({ sceneId: "world" }) },
  { sceneId: "world" });
 assert.equal(bridge.state().canUndo, false);
 assert.equal(bridge.undo(), undefined);
 const outcome = await authorViaBridge(bridge, "创建图元", [
  { id: "create-box", type: "object.create-primitive", target: target("new-box"), name: "box", kind: "box" as const, color: "#1683ff" },
  { id: "move", type: "object.set-transform", target: target("new-box"), position: [3, 0, 0] },
 ]);
 assert.equal(outcome.status, "committed");
 const state = bridge.state();
 assert.equal(state.canUndo, true); assert.equal(state.undoLabel, "创建图元"); assert.equal(state.canRedo, false);
 const hashBefore = bridge.runtime.owner.compileRuntimePackage({ packageId: "scene.owner-pkg", revision: 42 }).runtimePackage.packageHash.value;
 // 撤销:图元从 graph/注册表消失=资源释放;重水合 flush 重建的空间索引清空;包投影零实例。
 const undone = bridge.undo()!;
 assert.equal(undone.snapshot.primitives.length, 0);
 assert.equal(undone.runtime.owner.has("new-box"), false);
 assert.equal(undone.runtime.graph.has("new-box"), false);
 assert.deepEqual(spatialOf(undone.flush).queryAabb({ min: [-10, -10, -10], max: [10, 10, 10] }).ids, []);
 assert.equal(undone.runtime.owner.compileRuntimePackage({ packageId: "scene.owner-pkg", revision: 42 }).renderPacket.instances.length, 0);
 assert.equal(bridge.state().canRedo, true);
 // 重做:图元带权威变换恢复;包哈希与撤销前逐字节一致(同 revision 编译输入)。
 const redone = bridge.redo()!;
 assert.equal(redone.runtime.owner.get("new-box")!.transform.position.x, 3);
 assert.deepEqual(spatialOf(redone.flush).queryAabb({ min: [1, -2, -2], max: [5, 2, 2] }).ids, ["new-box"]);
 const hashRedone = redone.runtime.owner.compileRuntimePackage({ packageId: "scene.owner-pkg", revision: 42 }).runtimePackage.packageHash.value;
 assert.equal(hashRedone, hashBefore);
 cases.push("H-C7-P4 history bridge: port create → host undo releases primitive+resources, redo restores hash-identically");

});
it("H-C7-P4 history bridge: undo restores a deleted primitive with its pruned references; redo re-prunes", async () => {

 const owner = new ScenePrimitiveOwner({ sceneId: "world" });
 const graph = new SceneTransformGraph<string>();
 owner.createPrimitive(primitiveAt("victim", 5, "#ff8844"));
 owner.createPrimitive(primitiveAt("keeper", -5, "#00ff00"));
 graph.create({ id: "victim", localTransform: transform(5), localBounds: owner.localBounds("box") });
 graph.create({ id: "keeper", localTransform: transform(-5), localBounds: owner.localBounds("box") }); graph.flush();
 const refs = new SceneReferenceRegistry({ sceneId: "world", containers: {
  selectionSets: [{ id: "g1", name: "组一", objectIds: ["victim", "keeper"] }],
  rootLayerOrder: [{ kind: "object", id: "keeper" }, { kind: "object", id: "victim" }],
 } });
 const bridge = new SceneGraphHistoryBridge({ owner, graph, references: refs }, { sceneId: "world" });
 const outcome = await authorViaBridge(bridge, "删除图元", [{ id: "del", type: "object.delete-primitive", target: target("victim") }], { referenceCleanup: refs });
 assert.equal(outcome.status, "committed");
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds, ["keeper"]);
 assert.equal(bridge.runtime.owner.has("victim"), false);
 // 撤销:被删图元重水合恢复,被摘引用容器回写恢复——一个撤销条目覆盖两个域。
 const undone = bridge.undo()!;
 assert.equal(undone.runtime.owner.get("victim")!.color, "#ff8844");
 assert.equal(undone.runtime.owner.get("victim")!.transform.position.x, 5);
 assert.equal(undone.runtime.graph.has("victim"), true);
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds, ["victim", "keeper"]);
 assert.deepEqual(refs.state.rootLayerOrder, [{ kind: "object", id: "keeper" }, { kind: "object", id: "victim" }]);
 assert.deepEqual(spatialOf(undone.flush).queryAabb({ min: [3, -2, -2], max: [7, 2, 2] }).ids, ["victim"]);
 // 重做:删除重放——图元再释放,引用再摘除,包实例只剩 keeper。
 const redone = bridge.redo()!;
 assert.equal(redone.runtime.owner.has("victim"), false);
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds, ["keeper"]);
 assert.deepEqual(refs.state.rootLayerOrder, [{ kind: "object", id: "keeper" }]);
 assert.deepEqual(redone.runtime.owner.compileRuntimePackage({ packageId: "scene.owner-pkg", revision: 1 }).renderPacket.instances.map(instance => instance.id), ["keeper"]);
 cases.push("H-C7-P4 history bridge: undo restores deleted primitive + pruned references, redo re-prunes (package follows)");

});
it("H-C7-P4 history bridge: rolled-back transactions leave no entry; the bridge fails closed on rollback divergence", async () => {

 const bridge = new SceneGraphHistoryBridge(
  { owner: new ScenePrimitiveOwner({ sceneId: "world" }), graph: new SceneTransformGraph<string>() },
  { sceneId: "world" });
 // 失败批(重复 id):SDK 逆算子恢复图域,事务窗口关闭且不产生撤销条目。
 const outcome = await authorViaBridge(bridge, "失败创建", [
  { id: "c1", type: "object.create-primitive", target: target("dup"), name: "box", kind: "box" as const, color: "#1683ff" },
  { id: "c2", type: "object.create-primitive", target: target("dup"), name: "dup", kind: "sphere" as const, color: "#00ff00" },
 ]);
 assert.equal(outcome.status, "rolled-back");
 assert.equal(bridge.state().canUndo, false);
 assert.equal(bridge.runtime.owner.has("dup"), false);
 assert.equal(bridge.runtime.graph.has("dup"), false);
 // 事务窗口:重入返回同一句柄;undo 在窗口开启时 fail-closed;过期句柄上的 rollback 是空操作。
 const open = bridge.begin("进行中");
 assert.equal(bridge.begin("重入"), open);
 assert.throws(() => bridge.undo(), /transaction is still open/);
 assert.equal(open.rollback()!.primitives.length, 0);
 assert.equal(open.active, false);
 assert.equal(open.rollback(), undefined);
 // 指纹守卫:伪 driver 的 rollback 故意不恢复图域——桥必须拒绝把漂移态续进撤销栈。
 const graph = bridge.runtime.graph;
 await assert.rejects(() => bridge.edit("漂移", async () => {
  const tx = plan(graph, [{ id: "rogue", type: "object.create-primitive", target: target("rogue-box"), name: "box", kind: "box" as const, color: "#123456" }]);
  const d = new SceneGraphTransactionDriver(graph, { sceneId: "world", transactionId: tx.id, baseRevision: tx.baseRevision, parser: { parse: parseSceneCommand }, primitiveOwner: bridge.runtime.owner });
  const controller = new AbortController();
  return commitSceneCommandTransaction(tx, {
   readRevision: () => d.readRevision(),
   apply: commands => { const applied = d.apply(commands); controller.abort(); return applied; },
   rollback: () => graph.revision, // 故意不恢复:driver 逆算子被绕过。
  }, controller.signal);
 }), /diverged/);
 assert.equal(bridge.state().canUndo, false);
 // 守卫之后撤销链仍可用:成功编辑落条目,撤销清空(回滚不污染栈)。
 await authorViaBridge(bridge, "创建图元", [{ id: "create-ok", type: "object.create-primitive", target: target("ok-box"), name: "box", kind: "box" as const, color: "#1683ff" }]);
 assert.equal(bridge.state().canUndo, true);
 assert.notEqual(bridge.undo(), undefined);
 assert.equal(bridge.state().canUndo, false);
 cases.push("H-C7-P4 history bridge: rolled-back leaves no entry; open-window undo refuses; rollback divergence fails closed; stack stays usable");

});
it("H-C7-P4 history bridge: a new committed edit clears the redo branch; repeated undo drains the stack", async () => {

 const bridge = new SceneGraphHistoryBridge(
  { owner: new ScenePrimitiveOwner({ sceneId: "world" }), graph: new SceneTransformGraph<string>() },
  { sceneId: "world" });
 await authorViaBridge(bridge, "创建甲", [{ id: "create-a", type: "object.create-primitive", target: target("node-a"), name: "a", kind: "box" as const, color: "#1683ff" }]);
 assert.equal(bridge.undo()!.snapshot.primitives.length, 0);
 assert.equal(bridge.state().canRedo, true);
 // 撤销后的新提交清除重做分支(浏览器 SceneAuthoringHistory.record 语义)。
 await authorViaBridge(bridge, "创建乙", [{ id: "create-b", type: "object.create-primitive", target: target("node-b"), name: "b", kind: "sphere" as const, color: "#00ff00" }]);
 assert.equal(bridge.state().canRedo, false);
 assert.equal(bridge.runtime.owner.get("node-b")!.kind, "sphere");
 // 双层栈逐级退:node-b 先退(甲仍在),再退到栈底清空,空栈 undo 为 undefined。
 const firstUndo = bridge.undo()!;
 assert.equal(firstUndo.runtime.owner.has("node-b"), false);
 assert.equal(bridge.state().canUndo, false);
 const secondBridge = new SceneGraphHistoryBridge(
  { owner: new ScenePrimitiveOwner({ sceneId: "world" }), graph: new SceneTransformGraph<string>() },
  { sceneId: "world" });
 await authorViaBridge(secondBridge, "创建甲", [{ id: "create-a2", type: "object.create-primitive", target: target("node-a2"), name: "a", kind: "box" as const, color: "#1683ff" }]);
 await authorViaBridge(secondBridge, "创建乙", [{ id: "create-b2", type: "object.create-primitive", target: target("node-b2"), name: "b", kind: "sphere" as const, color: "#00ff00" }]);
 const levelOne = secondBridge.undo()!;
 assert.equal(levelOne.runtime.owner.has("node-b2"), false);
 assert.equal(levelOne.runtime.owner.has("node-a2"), true);
 assert.equal(secondBridge.state().canUndo, true);
 const levelTwo = secondBridge.undo()!;
 assert.equal(levelTwo.runtime.owner.list().length, 0);
 assert.equal(secondBridge.state().canUndo, false);
 assert.equal(secondBridge.undo(), undefined);
 cases.push("H-C7-P4 history bridge: new committed edit clears redo branch; repeated undo drains to empty stack");

});
it("H-C7-P4 history bridge: one entry per window collapses multi-domain edits; camera edits stay out of the authoring stack", async () => {

 const camera = new SceneCameraOwner({ sceneId: "world" });
 const bridge = new SceneGraphHistoryBridge(
  { owner: new ScenePrimitiveOwner({ sceneId: "world" }), graph: new SceneTransformGraph<string>() },
  { sceneId: "world" });
 await authorViaBridge(bridge, "创建图元", [{ id: "create-a", type: "object.create-primitive", target: target("a"), name: "a", kind: "box" as const, color: "#1683ff" }]);
 await authorViaBridge(bridge, "润色图元", [
  { id: "move", type: "object.set-transform", target: target("a"), position: [4, 0, 0] },
  { id: "mat", type: "material.set", target: target("a"), patch: { color: "#ff8800", metalness: 0.8 } },
 ], { capabilities: ["studio.object", "studio.material"] });
 assert.equal(bridge.state().undoLabel, "润色图元");
 // 撤销粒度=事务窗口:一次撤销回到润色前(原位、无材质),不是命令级半程快照。
 const undone = bridge.undo()!;
 assert.equal(undone.runtime.owner.get("a")!.transform.position.x, 0);
 assert.equal(undone.runtime.owner.get("a")!.material, undefined);
 bridge.redo();
 assert.equal(bridge.runtime.owner.get("a")!.material!.metalness, 0.8);
 // 相机命令即使 committed 也不进作者栈:条目计数与标签不变(相机浏览不是作者编辑)。
 const camOutcome = await authorViaBridge(bridge, "设定相机", [{ id: "cam", type: "camera.set", sceneId: "world", position: [7, 7, 7], target: [0, 0, 0] }], { capabilities: ["studio.object", "studio.camera"], cameraPort: camera });
 assert.equal(camOutcome.status, "committed");
 assert.deepEqual(camera.snapshot().pose!.position, [7, 7, 7]);
 assert.equal(bridge.state().canUndo, true);
 assert.equal(bridge.state().undoLabel, "润色图元");
 // 作者撤销不触碰相机 pose(graph 线与浏览器同规:相机由 driver 级逆算子在 SDK rollback 内自管)。
 const undoneAgain = bridge.undo()!;
 assert.deepEqual(camera.snapshot().pose!.position, [7, 7, 7]);
 assert.equal(undoneAgain.runtime.owner.get("a")!.transform.position.x, 0);
 cases.push("H-C7-P4 history bridge: one entry per window; camera edits dedupe out of the stack and survive authoring undo");

});
