import { it } from "vitest";
import assert from "node:assert/strict";
import { SceneTransformGraph } from "@bim-studio/deep-engine/scene";
import { SceneGraphTransactionDriver } from "./SceneGraphTransactionDriver";
import { ScenePrimitiveOwner, primitiveStateFromCommand, restoreSceneFromSnapshot } from "./ScenePrimitiveOwnerPort";
import { SceneGraphHistoryBridge } from "./SceneGraphHistoryBridge";
import { SceneCameraOwner, type SceneCameraPort, type SceneCameraPose } from "./SceneCameraPort";
import { SceneReferenceRegistry, SceneReferenceResolutionError, resolveSceneReferenceIntegrity } from "./SceneReferenceCleanupPort";
import { assembleCameraFlyTween, playCameraFlyTween } from "./SceneCameraFlyTween";
import type { ModelKeyframe, SceneAnimationState, SceneAssetBindingState, SimulationEntityState } from "@bim-studio/contracts";
import { commitSceneCommandTransaction, prepareSceneCommandTransaction } from "@bim-studio/scene-sdk";
import { parseSceneCommand } from "@bim-studio/scene-sdk";

const cases: string[]=[];
const transform=(x:number)=>({kind:"trs" as const,translation:[x,0,0] as const,rotation:[0,0,0,1] as const,scale:[1,1,1] as const});
const target=(id="child",sceneId="world")=>({kind:"object" as const,sceneId,objectId:id});
function plan(graph:SceneTransformGraph<string>,commands:unknown[],capabilities:readonly string[]=["studio.object"]){
 const prepared=prepareSceneCommandTransaction({id:"tx:author",sceneId:"world",baseRevision:graph.revision,module:{id:"author",capabilities:[...capabilities] as never,permissions:["scene.write"]},commands});
 assert.equal(prepared.status,"prepared");if(prepared.status!=="prepared")throw Error("prepare failed");return prepared.plan;
}

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

/** 图元态与 graph 节点同位构造(撤销重水合后世界位保持)。 */
const primitiveAt = (id: string, x: number, color: string) => ({
  ...primitiveStateFromCommand({ target: target(id), name: id, kind: "box" as const, color }),
  transform: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
});

/* ===== H-C7-P3 第五批:assetBindings 消费化(拒绝列出/宿主解绑清理路)+ 相机 Tween 装配示例 ===== */

/** 设备资产绑定 fixture(sceneObjectId 指向被删对象)。 */
const bindingOf = (id: string, objectId: string): SceneAssetBindingState =>
  ({ id, sceneObjectId: objectId, objectName: objectId, modelId: objectId, deviceId: `pump-${id}`, confidence: 1, confirmedAt: "2026-10-02T00:00:00.000Z" });

it("H-C7-P5 assetBindings refuse deletion and list every bound id; the whole batch stays untouched", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 owner.createPrimitive({...primitiveStateFromCommand({target:target("victim"),name:"victim",kind:"box",color:"#ff8844"})});
 graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});graph.flush();
 // 两枚绑定同指 victim:拒绝语义=整批拒绝并列出全部命中 id(浏览器『设备资产引用尚未接入删除』同形)。
 const bindings=[bindingOf("asset-a","victim"),bindingOf("asset-b","victim")];
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"组一",objectIds:["victim"]}],
  rootLayerOrder:[{kind:"object",id:"victim"}],
  assetBindings:bindings,
 }});
 // registry 级:先检查后清理——assetBindings 检查在最前,选择集不做任何摘除。
 assert.throws(()=>refs.pruneDeletedObjectReferences("victim"),/asset-a、asset-b.*尚未接入删除/);
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds,["victim"]);
 const tx=plan(graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner,referenceCleanup:refs});
 assert.throws(()=>d.apply(tx.commands),/asset-a、asset-b/);
 assert.equal((await commitSceneCommandTransaction(tx,new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:"tx:del2",baseRevision:graph.revision,parser:{parse:parseSceneCommand},primitiveOwner:owner,referenceCleanup:refs}))).status,"rolled-back");
 // 零变更:图元/节点/引用容器(含未列出的 selectionSets)全部保持 before 态。
 assert.equal(owner.has("victim"),true);assert.equal(graph.has("victim"),true);
 assert.deepEqual(JSON.parse(JSON.stringify(refs.state)),{selectionSets:[{id:"g1",name:"组一",objectIds:["victim"]}],rootLayerOrder:[{kind:"object",id:"victim"}],assetBindings:bindings});
 cases.push("H-C7-P5 assetBindings deletion refuses atomically and lists every bound id; zero mutation across owner/graph/references");

});
it("H-C7-P5 host unbind cleanup path: removeAssetBindingsFor lets deletion proceed; SDK rollback restores the binding", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 owner.createPrimitive({...primitiveStateFromCommand({target:target("victim"),name:"victim",kind:"box",color:"#ff8844"})});
 owner.createPrimitive({...primitiveStateFromCommand({target:target("keeper"),name:"keeper",kind:"box",color:"#00ff00"})});
 graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});
 graph.create({id:"keeper",localTransform:transform(-5),localBounds:owner.localBounds("box")});graph.flush();
 const binding=bindingOf("asset-victim","victim");
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"组一",objectIds:["victim","keeper"]}],
  rootLayerOrder:[{kind:"object",id:"victim"}],
  assetBindings:[binding,bindingOf("asset-keeper","keeper")],
 }});
 // 清理路=宿主显式解绑(浏览器『请先移除该引用』的可编程形):按原序返回深拷贝,其余绑定不动。
 const removed=refs.removeAssetBindingsFor("victim");
 assert.deepEqual(removed,[binding]);
 assert.deepEqual(refs.state.assetBindings![0]!.id,"asset-keeper");
 assert.deepEqual(refs.removeAssetBindingsFor("victim"),[]);
 const tx=plan(graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner,referenceCleanup:refs});
 const controller=new AbortController();
 const outcome=await commitSceneCommandTransaction(tx,{readRevision:()=>d.readRevision(),apply:commands=>{const applied=d.apply(commands);controller.abort();return applied;},rollback:()=>d.rollback()},controller.signal);
 assert.equal(outcome.status,"rolled-back");
 // SDK 取消:解绑后的删除照常走既有逆算子——引用容器恢复到事务 before 态(=解绑后状态:
 // 解绑本身是事务外的宿主决定,不在删除事务的回滚域内);图元与选择集精确恢复。
 assert.deepEqual(refs.state.assetBindings,[bindingOf("asset-keeper","keeper")]);
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds,["victim","keeper"]);
 assert.equal(owner.has("victim"),true);assert.equal(graph.has("victim"),true);
 assert.equal(d.rollback(),graph.revision);
 // 正常提交:解绑后删除成功,selectionSets 摘引用,keeper 的绑定不受牵连。
 const tx2=plan(graph,[{id:"del2",type:"object.delete-primitive",target:target("victim")}]);
 const d2=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx2.id,baseRevision:tx2.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner,referenceCleanup:refs});
 assert.equal((await commitSceneCommandTransaction(tx2,d2)).status,"committed");
 assert.equal(owner.has("victim"),false);
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds,["keeper"]);
 assert.deepEqual(refs.state.rootLayerOrder,[]);
 assert.deepEqual(refs.state.assetBindings![0]!.id,"asset-keeper");
 cases.push("H-C7-P5 host unbind (removeAssetBindingsFor) enables deletion; SDK rollback restores the unbound binding exactly");

});
it("H-C7-P5 history bridge carries assetBindings through undo/redo; a bound bystander keeps its binding", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 owner.createPrimitive(primitiveAt("victim",5,"#ff8844"));
 owner.createPrimitive(primitiveAt("keeper",-5,"#00ff00"));
 graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});
 graph.create({id:"keeper",localTransform:transform(-5),localBounds:owner.localBounds("box")});graph.flush();
 // keeper 仍被设备资产绑定(删除 victim 与它无关):绑定域要随快照完整穿越 undo/redo。
 const binding=bindingOf("asset-keeper","keeper");
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"组一",objectIds:["victim"]}],
  rootLayerOrder:[{kind:"object",id:"victim"}],
  assetBindings:[binding],
 }});
 const bridge=new SceneGraphHistoryBridge({owner,graph,references:refs},{sceneId:"world"});
 assert.deepEqual(bridge.capture().assetBindings,[binding]);
 const outcome=await authorViaBridge(bridge,"删除图元",[{id:"del",type:"object.delete-primitive",target:target("victim")}],{referenceCleanup:refs});
 assert.equal(outcome.status,"committed");
 assert.deepEqual(refs.state.assetBindings,[binding]);
 assert.equal(bridge.runtime.owner.has("victim"),false);
 // 撤销:绑定随快照重水合回同一注册表实例(宿主句柄有效),图元恢复;重做:再删,绑定仍在。
 const undone=bridge.undo()!;
 assert.deepEqual(refs.state.assetBindings,[binding]);
 assert.equal(undone.runtime.owner.has("victim"),true);
 const redone=bridge.redo()!;
 assert.deepEqual(refs.state.assetBindings,[binding]);
 assert.equal(redone.runtime.owner.has("victim"),false);
 cases.push("H-C7-P5 history bridge: assetBindings ride undo/redo snapshots intact; a bound bystander keeps its binding");

});
it("H-C7-P5 camera fly tween: exact endpoints, eased bounded progress, and port-driven playback without driver fly-to", async () => {

 const from:SceneCameraPose={position:[0,0,10],target:[0,0,0],near:0.5,far:500,fov:55};
 const to:SceneCameraPose={position:[6,0,10],target:[3,0,0],near:0.8,far:800,fov:60};
 const tween=assembleCameraFlyTween(from,to,{durationMs:250});
 // 端点精确 + 越界截断;缺省键不静默补默认(两侧同有 near/far/fov 才插值)。
 assert.deepEqual(tween.sample(0),from);assert.deepEqual(tween.sample(250),to);
 assert.deepEqual(tween.sample(-5),from);assert.deepEqual(tween.sample(999),to);
 // easeInOutCubic(0.25)=0.0625:x=0.375,慢于线性(1.5);t=0.5 恰为半程。
 assert.ok(Math.abs(tween.sample(62.5)!.position[0]!-0.375)<1e-12);
 assert.ok(tween.sample(62.5)!.position[0]!<1.5);
 assert.deepEqual(tween.sample(125)!.position,[3,0,10]);
 // 单调有界:任意缓动下进度截断,采样不越过起终点。
 for(let step=0;step<=20;step+=1){
  const pose=tween.sample(step*15);
  assert.ok(pose.position[0]!>=-1e-12&&pose.position[0]!<=6+1e-12);
 }
 // 装配守卫:durationMs<=0/非有限如实拒绝;非有限 pose 拒绝。
 assert.throws(()=>assembleCameraFlyTween(from,to,{durationMs:0}),/durationMs/);
 assert.throws(()=>assembleCameraFlyTween(from,{position:[Number.NaN,0,0],target:[0,0,0]},{durationMs:250}),/finite/);
 // 播放循环:只驱动 cameraPort.setCamera(从不到事务驱动发 durationMs>0 的 fly-to),终点帧精确落位。
 const camera=new SceneCameraOwner({sceneId:"world"});
 const frames:SceneCameraPose[]=[];
 const recorder:SceneCameraPort={
  setCamera:pose=>{camera.setCamera(pose);frames.push(camera.snapshot().pose!);},
  flyTo:intent=>camera.flyTo(intent),snapshot:()=>camera.snapshot(),restore:shot=>camera.restore(shot),
 };
 const finalPose=playCameraFlyTween(recorder,tween);
 assert.deepEqual(finalPose,to);assert.deepEqual(frames[0]!,from);assert.deepEqual(frames[frames.length-1]!,to);
 assert.ok(frames.length>=3);
 for(let index=1;index<frames.length;index+=1)assert.ok(frames[index]!.position[0]!>=frames[index-1]!.position[0]!-1e-12);
 // 集成契约:driver 对 durationMs>0 的 fly-to 仍如实拒绝——Tween 播放层是唯一的时长通道。
 const graph=new SceneTransformGraph<string>();graph.flush();
 const caps=["studio.object","studio.camera"];
 const tx=plan(graph,[{id:"fly-tweened",type:"camera.fly-to",sceneId:"world",target:{position:[9,9,9]},durationMs:250}],caps);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},cameraPort:recorder});
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"rolled-back");
 assert.deepEqual(camera.snapshot().pose,to);
 cases.push("H-C7-P5 camera fly tween assembles exact endpoints with bounded eased progress; playback drives the port only (driver still refuses durationMs>0)");

});

/* ===== H-C7-P3 第六批:动画/仿真引用消费化(删除流消费 + 加载解析门 + 循环防护) ===== */

const frameAt=(id:string,time:number,modelId:string):ModelKeyframe=>({id,time,modelId,transform:{position:{x:time,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}}});
/** victim/keeper 双图元 + 动画/仿真引用夹具:状态机锚(initial/active)锚在 keeper 状态 s2
 * (victim 可删);时间线/状态机/事件/仿真四域引用两对象,消费与保留可对照。 */
const referenceFixture=(anchor:string="s2")=>{
 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 owner.createPrimitive({...primitiveStateFromCommand({target:target("victim"),name:"victim",kind:"box",color:"#ff8844"})});
 owner.createPrimitive({...primitiveStateFromCommand({target:target("keeper"),name:"keeper",kind:"box",color:"#00ff00"})});
 graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});
 graph.create({id:"keeper",localTransform:transform(-5),localBounds:owner.localBounds("box")});graph.flush();
 const animation:SceneAnimationState={
  duration:4,loop:false,camera:[],
  models:[frameAt("f1",0,"victim"),frameAt("f2",1,"victim"),frameAt("f3",2,"keeper")],
  stateMachine:{
   enabled:true,initialStateId:anchor,activeStateId:"s2",transitionDuration:0.2,
   states:[{id:"s1",name:"victim-state",modelId:"victim",clipId:"c1",loop:true},{id:"s2",name:"keeper-state",modelId:"keeper",clipId:"c2",loop:false}],
   transitions:[{id:"t1",fromStateId:"s1",toStateId:"s2",parameter:"go",equals:true},{id:"t2",fromStateId:"s2",toStateId:"s1",parameter:"back",equals:true}],
   events:[{clipId:"c1",eventId:"e-victim",time:0.5},{clipId:"c2",eventId:"e-keeper",time:0.2}],
  },
 };
 const simulationEntities:SimulationEntityState[]=[
  {id:"node-k",kind:"flowNode",targetModelId:"keeper",node:{id:"node-k",name:"库",kind:"sink"}},
  {id:"link-1",kind:"flowLink",fromModelId:"victim",toModelId:"keeper"},
  {id:"path-1",kind:"path",name:"p",targetModelId:"victim",points:[[0,0,0],[1,0,0]],loopMode:"once",speed:1},
  {id:"pair-1",kind:"collisionPair",name:"c",a:{modelId:"victim"},b:{modelId:"keeper"},tolerance:0.01},
 ];
 return {owner,graph,animation,simulationEntities};
};

it("H-C7-P3 deletion consumes animation timeline/state-machine/clip-events and simulation entities; SDK cancel restores them exactly", async () => {

 const f=referenceFixture();
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"组一",objectIds:["victim","keeper"]}],
  rootLayerOrder:[{kind:"object",id:"victim"},{kind:"object",id:"keeper"}],
  animation:f.animation,simulationEntities:f.simulationEntities,
 }});
 const tx=plan(f.graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
 const d=new SceneGraphTransactionDriver(f.graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:f.owner,referenceCleanup:refs});
 const controller=new AbortController();
 const outcome=await commitSceneCommandTransaction(tx,{readRevision:()=>d.readRevision(),apply:commands=>{const applied=d.apply(commands);controller.abort();return applied;},rollback:()=>d.rollback()},controller.signal);
 assert.equal(outcome.status,"rolled-back");
 // SDK 取消:动画/仿真容器按事务 before 态深恢复,图元与节点恢复——删除消费可逆。
 assert.deepEqual(refs.state.animation,f.animation);
 assert.deepEqual(refs.state.simulationEntities,f.simulationEntities);
 assert.equal(f.owner.has("victim"),true);assert.equal(f.graph.has("victim"),true);
 assert.equal(d.rollback(),f.graph.revision);
 // 正常提交:时间线 victim 帧 f1/f2 摘除(f3 保留)、状态机 s1 连同触及转移 t1/t2 摘除、
 // s1 的 clip c1 事件标记摘除(c2 事件保留)、仿真实体中引用 victim 的三只移除
 // (keeper 的 flowNode 保留);选择集/根层序照旧消费;序列化容器零悬空 victim 引用。
 const tx2=plan(f.graph,[{id:"del2",type:"object.delete-primitive",target:target("victim")}]);
 const d2=new SceneGraphTransactionDriver(f.graph,{sceneId:"world",transactionId:tx2.id,baseRevision:tx2.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:f.owner,referenceCleanup:refs});
 assert.equal((await commitSceneCommandTransaction(tx2,d2)).status,"committed");
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds,["keeper"]);
 assert.deepEqual(refs.state.rootLayerOrder,[{kind:"object",id:"keeper"}]);
 assert.deepEqual(refs.state.animation!.models.map(frame=>frame.id),["f3"]);
 const machine=refs.state.animation!.stateMachine!;
 assert.deepEqual(machine.states.map(state=>state.id),["s2"]);
 assert.deepEqual(machine.transitions,[]);
 assert.deepEqual(machine.events!.map(event=>event.eventId),["e-keeper"]);
 assert.equal(machine.initialStateId,"s2");assert.equal(machine.activeStateId,"s2");
 assert.deepEqual(refs.state.simulationEntities!.map(entity=>entity.id),["node-k"]);
 assert.equal(f.owner.has("victim"),false);assert.equal(f.graph.has("victim"),false);
 // 消费后的容器再经 JSON 序列化往返,victim 引用零悬空(序列化即消费态)。
 const serialized=JSON.parse(JSON.stringify({animation:refs.state.animation,simulationEntities:refs.state.simulationEntities}));
 assert.equal(JSON.stringify(serialized).includes("victim"),false);
 cases.push("H-C7-P3 deletion consumes animation timeline/state-machine/clip-events + simulation entities; SDK cancel restores containers deeply");

});

it("H-C7-P3 deletion with no matching animation/simulation references is a no-op prune (absent containers and non-referencing objects)", async () => {

 const f=referenceFixture();
 // 容器缺省(引用缺失):删除照常提交,清理零消费。
 const refs=new SceneReferenceRegistry({sceneId:"world"});
 const tx=plan(f.graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
 const d=new SceneGraphTransactionDriver(f.graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:f.owner,referenceCleanup:refs});
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");
 assert.equal(f.owner.has("victim"),false);
 // 引用存在但不指向被删对象:旁观者图元不被任何域引用——删除它时动画/仿真/选择集零消费、零误伤。
 f.owner.createPrimitive({...primitiveStateFromCommand({target:target("bystander"),name:"bystander",kind:"box",color:"#888888"})});
 f.graph.create({id:"bystander",localTransform:transform(15),localBounds:f.owner.localBounds("box")});f.graph.flush();
 const refs2=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"g",objectIds:["victim"]}],rootLayerOrder:[{kind:"object",id:"victim"}],
  animation:structuredClone(f.animation),simulationEntities:structuredClone(f.simulationEntities),
 }});
 const tx2=plan(f.graph,[{id:"del-bystander",type:"object.delete-primitive",target:target("bystander")}]);
 const d2=new SceneGraphTransactionDriver(f.graph,{sceneId:"world",transactionId:tx2.id,baseRevision:tx2.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:f.owner,referenceCleanup:refs2});
 assert.equal((await commitSceneCommandTransaction(tx2,d2)).status,"committed");
 assert.deepEqual(refs2.state.selectionSets[0]!.objectIds,["victim"]);
 assert.deepEqual(refs2.state.animation!.models.map(frame=>frame.id),["f1","f2","f3"]);
 assert.deepEqual(refs2.state.animation!.stateMachine!.states.map(state=>state.id),["s1","s2"]);
 assert.deepEqual(refs2.state.animation!.stateMachine!.events!.map(event=>event.eventId),["e-victim","e-keeper"]);
 assert.deepEqual(refs2.state.simulationEntities!.map(entity=>entity.id),["node-k","link-1","path-1","pair-1"]);
 assert.equal(f.owner.has("bystander"),false);
 cases.push("H-C7-P3 deletion without matching animation/simulation references is a no-op prune (absent containers and non-referencing objects)");

});

it("H-C7-P3 state-machine anchor consumed by deletion refuses atomically with an explicit error code and zero mutation", async () => {

 // 锚迁移用例:initial 锚在 victim 状态 s1 上——消费 s1 会失去初始锚,删除如实拒绝。
 const f=referenceFixture("s1");
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"g",objectIds:["victim"]}],rootLayerOrder:[],animation:f.animation,simulationEntities:f.simulationEntities,
 }});
 const tx=plan(f.graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
 // driver 直连 apply:锚守卫的错误码精确可见(SDK commit 会把 apply 抛错折叠为 rolled-back receipt)。
 const direct=new SceneGraphTransactionDriver(f.graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:f.owner,referenceCleanup:refs});
 await assert.rejects(async () => direct.apply(tx.commands), (error: unknown) => {
  assert.ok(error instanceof SceneReferenceResolutionError);
  assert.equal((error as SceneReferenceResolutionError).code,"STATE_MACHINE_ANCHOR_CONSUMED");
  return true;
 });
 // SDK 原子性:同一拒绝经 commit 返回 rolled-back;先检查后消费,零变更。
 const tx2=plan(f.graph,[{id:"del2",type:"object.delete-primitive",target:target("victim")}]);
 const viaSdk=new SceneGraphTransactionDriver(f.graph,{sceneId:"world",transactionId:tx2.id,baseRevision:tx2.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:f.owner,referenceCleanup:refs});
 assert.equal((await commitSceneCommandTransaction(tx2,viaSdk)).status,"rolled-back");
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds,["victim"]);
 assert.equal(f.owner.has("victim"),true);assert.equal(f.graph.has("victim"),true);
 assert.deepEqual(refs.state.animation!.models.map(frame=>frame.id),["f1","f2","f3"]);
 cases.push("H-C7-P3 state-machine anchor on a consumed state refuses deletion with STATE_MACHINE_ANCHOR_CONSUMED, zero mutation");

});

it("H-C7-P3 reopen resolves animation/simulation references to runtime resources; dangling object ids refuse load with explicit codes", async () => {

 const f=referenceFixture();
 const snapshot=f.owner.snapshotScene();
 snapshot.selectionSets=[];snapshot.rootLayerOrder=[];
 snapshot.animation=structuredClone(f.animation);
 snapshot.simulationEntities=structuredClone(f.simulationEntities);
 // 全部引用可解析(victim/keeper 都是 port 图元):重开通过——引用→运行时资源链路闭合。
 const reopened=restoreSceneFromSnapshot({snapshot:JSON.parse(JSON.stringify(snapshot)),sceneId:"world"});
 assert.equal(reopened.owner.list().length,2);
 assert.deepEqual(reopened.snapshot.animation!.models.map(frame=>frame.id),["f1","f2","f3"]);
 // ID 悬空:动画时间线引用不存在的对象 → ANIMATION_REF_DANGLING。
 const danglingAnimation=structuredClone(snapshot);danglingAnimation.animation!.models.push(frameAt("f-dangling",3,"ghost"));
 assert.throws(() => restoreSceneFromSnapshot({snapshot:danglingAnimation,sceneId:"world"}), (error: unknown) => {
  assert.ok(error instanceof SceneReferenceResolutionError);
  assert.equal((error as SceneReferenceResolutionError).code,"ANIMATION_REF_DANGLING");
  return true;
 });
 // ID 悬空:仿真实体引用不存在的对象 → SIMULATION_REF_DANGLING。
 const danglingSimulation=structuredClone(snapshot);
 danglingSimulation.simulationEntities!.push({id:"link-ghost",kind:"flowLink",fromModelId:"ghost",toModelId:"keeper"});
 assert.throws(() => restoreSceneFromSnapshot({snapshot:danglingSimulation,sceneId:"world"}), (error: unknown) => {
  assert.ok(error instanceof SceneReferenceResolutionError);
  assert.equal((error as SceneReferenceResolutionError).code,"SIMULATION_REF_DANGLING");
  return true;
 });
 cases.push("H-C7-P3 reopen resolves animation/simulation references to runtime resources; dangling ids refuse with ANIMATION/SIMULATION_REF_DANGLING");

});

it("H-C7-P3 unknown simulation entity shapes refuse type-mismatched fail-closed at both load gate and deletion check", async () => {

 const f=referenceFixture();
 const mismatched=structuredClone(f.simulationEntities!) as unknown[];
 mismatched.push({id:"weird-1",kind:"teleporter",fromModelId:"victim"} as never);
 // 加载门:未知形状 → SIMULATION_ENTITY_TYPE_MISMATCH(不静默跳过)。
 const snapshot=f.owner.snapshotScene();
 snapshot.simulationEntities=mismatched as never;
 assert.throws(() => restoreSceneFromSnapshot({snapshot,sceneId:"world"}), (error: unknown) => {
  assert.ok(error instanceof SceneReferenceResolutionError);
  assert.equal((error as SceneReferenceResolutionError).code,"SIMULATION_ENTITY_TYPE_MISMATCH");
  return true;
 });
 // 删除流:未知形状存在时先检查后消费整批拒绝(可能以未知形态引用该对象),零变更。
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{selectionSets:[{id:"g1",name:"g",objectIds:["victim"]}],rootLayerOrder:[],simulationEntities:mismatched as never}});
 const tx=plan(f.graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
 // driver 直连 apply 验错误码;再经 SDK commit 验原子性(SDK 把 apply 抛错折叠为 rolled-back)。
 const direct=new SceneGraphTransactionDriver(f.graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:f.owner,referenceCleanup:refs});
 await assert.rejects(async () => direct.apply(tx.commands), (error: unknown) => {
  assert.ok(error instanceof SceneReferenceResolutionError);
  assert.equal((error as SceneReferenceResolutionError).code,"SIMULATION_ENTITY_TYPE_MISMATCH");
  return true;
 });
 const tx2=plan(f.graph,[{id:"del2",type:"object.delete-primitive",target:target("victim")}]);
 const viaSdk=new SceneGraphTransactionDriver(f.graph,{sceneId:"world",transactionId:tx2.id,baseRevision:tx2.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:f.owner,referenceCleanup:refs});
 assert.equal((await commitSceneCommandTransaction(tx2,viaSdk)).status,"rolled-back");
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds,["victim"]);
 assert.equal(f.owner.has("victim"),true);
 cases.push("H-C7-P3 unknown simulation entity shapes refuse SIMULATION_ENTITY_TYPE_MISMATCH at load gate and deletion check (zero mutation)");

});

it("H-C7-P3 reference resolution survives cyclic state machines via a visited-set walk; dangling state and clip-event refs refuse with codes", async () => {

 const f=referenceFixture();
 // 环形转移 s1→s2→s1 是状态机合法语义:解析遍历必须终止且接受(循环引用防护)。
 resolveSceneReferenceIntegrity({animation:f.animation,isKnownObject:id => id==="victim"||id==="keeper"});
 // 转移端点悬空 → STATE_MACHINE_STATE_REF_DANGLING。
 const brokenTransition=structuredClone(f.animation);
 brokenTransition.stateMachine!.transitions!.push({id:"t-broken",fromStateId:"s2",toStateId:"s-ghost",parameter:"x",equals:true});
 assert.throws(() => resolveSceneReferenceIntegrity({animation:brokenTransition,isKnownObject:() => true}), (error: unknown) => {
  assert.ok(error instanceof SceneReferenceResolutionError);
  assert.equal((error as SceneReferenceResolutionError).code,"STATE_MACHINE_STATE_REF_DANGLING");
  return true;
 });
 // 初始状态锚悬空(容器内部引用) → STATE_MACHINE_STATE_REF_DANGLING。
 const brokenAnchor=structuredClone(f.animation);
 brokenAnchor.stateMachine!.initialStateId="s-ghost";
 assert.throws(() => resolveSceneReferenceIntegrity({animation:brokenAnchor,isKnownObject:() => true}), (error: unknown) => {
  assert.ok(error instanceof SceneReferenceResolutionError);
  assert.equal((error as SceneReferenceResolutionError).code,"STATE_MACHINE_STATE_REF_DANGLING");
  return true;
 });
 // clip 事件标记引用容器内不存在的 clip → ANIMATION_CLIP_REF_DANGLING。
 const brokenEvent=structuredClone(f.animation);
 brokenEvent.stateMachine!.events!.push({clipId:"c-ghost",eventId:"e-ghost",time:1});
 assert.throws(() => resolveSceneReferenceIntegrity({animation:brokenEvent,isKnownObject:() => true}), (error: unknown) => {
  assert.ok(error instanceof SceneReferenceResolutionError);
  assert.equal((error as SceneReferenceResolutionError).code,"ANIMATION_CLIP_REF_DANGLING");
  return true;
 });
 // 重开链同样拒绝端点悬空的状态机(fail-closed,不静默丢转移)。
 const snapshot=f.owner.snapshotScene();
 snapshot.animation=brokenTransition;
 assert.throws(() => restoreSceneFromSnapshot({snapshot,sceneId:"world"}), SceneReferenceResolutionError);
 cases.push("H-C7-P3 cyclic state machines resolve via visited-set walk; dangling transition endpoints/anchors and clip events refuse with explicit codes");

});

it("H-C7-P3 consumed animation/simulation containers serialize roundtrip and ride undo/redo with the load gate", async () => {

 const f=referenceFixture();
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"g",objectIds:["victim"]}],rootLayerOrder:[{kind:"object",id:"victim"}],
  animation:structuredClone(f.animation),simulationEntities:structuredClone(f.simulationEntities),
 }});
 const bridge=new SceneGraphHistoryBridge({owner:f.owner,graph:f.graph,references:refs},{sceneId:"world"});
 const outcome=await authorViaBridge(bridge,"删除图元",[{id:"del",type:"object.delete-primitive",target:target("victim")}],{referenceCleanup:refs});
 assert.equal(outcome.status,"committed");
 // 消费态序列化往返:JSON 落盘→新注册表水合→语义一致(可继续消费下一轮删除)。
 const serialized=JSON.parse(JSON.stringify({selectionSets:refs.state.selectionSets,rootLayerOrder:refs.state.rootLayerOrder,animation:refs.state.animation,simulationEntities:refs.state.simulationEntities}));
 const rehydrated=new SceneReferenceRegistry({sceneId:"world",containers:serialized});
 assert.deepEqual(rehydrated.state.animation!.models.map(frame=>frame.id),["f3"]);
 assert.deepEqual(rehydrated.state.simulationEntities!.map(entity=>entity.id),["node-k"]);
 // 撤销:before 快照含 victim 引用+victim 图元,重水合经加载解析门通过、容器深恢复;
 // 重做:after 快照=消费态,再次通过解析门,消费结果复现。
 const undone=bridge.undo()!;
 assert.deepEqual(refs.state.animation!.models.map(frame=>frame.id),["f1","f2","f3"]);
 assert.deepEqual(refs.state.simulationEntities!.map(entity=>entity.id),["node-k","link-1","path-1","pair-1"]);
 assert.equal(undone.runtime.owner.has("victim"),true);
 const redone=bridge.redo()!;
 assert.deepEqual(refs.state.animation!.models.map(frame=>frame.id),["f3"]);
 assert.deepEqual(refs.state.simulationEntities!.map(entity=>entity.id),["node-k"]);
 assert.equal(redone.runtime.owner.has("victim"),false);
 cases.push("H-C7-P3 consumed animation/simulation containers serialize roundtrip and ride bridge undo/redo through the reference resolution gate");

});

