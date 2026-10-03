import { it } from "vitest";
import assert from "node:assert/strict";
import { SceneTransformGraph } from "@bim-studio/deep-engine/scene";
import { SceneTransformSpatialBridge } from "@bim-studio/deep-engine/scene";
import { LooseOctreeIndex } from "@bim-studio/deep-engine";
import { SceneGraphTransactionDriver } from "./SceneGraphTransactionDriver";
import { ScenePrimitiveOwner, primitiveStateFromCommand, restoreSceneFromSnapshot } from "./ScenePrimitiveOwnerPort";
import { SceneCameraOwner } from "./SceneCameraPort";
import { SceneReferenceRegistry } from "./SceneReferenceCleanupPort";
import { commitSceneCommandTransaction, prepareSceneCommandTransaction } from "@bim-studio/scene-sdk";
import { parseSceneCommand } from "@bim-studio/scene-sdk";
import { sceneHexToLinearRgb } from "../delivery/sceneNeutralAppearance";

const cases: string[]=[];
const transform=(x:number)=>({kind:"trs" as const,translation:[x,0,0] as const,rotation:[0,0,0,1] as const,scale:[1,1,1] as const});
const target=(id="child",sceneId="world")=>({kind:"object" as const,sceneId,objectId:id});
function plan(graph:SceneTransformGraph<string>,commands:unknown[],capabilities:readonly string[]=["studio.object"]){
 const prepared=prepareSceneCommandTransaction({id:"tx:author",sceneId:"world",baseRevision:graph.revision,module:{id:"author",capabilities:[...capabilities] as never,permissions:["scene.write"]},commands});
 assert.equal(prepared.status,"prepared");if(prepared.status!=="prepared")throw Error("prepare failed");return prepared.plan;
}

it("H-C7-P3 create-primitive hosts a real box geometry resource into RuntimePackage and consumes finalFlush spatial bounds", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();graph.flush();
 const index=new LooseOctreeIndex<string>({bounds:{min:[-1000,-1000,-1000],max:[1000,1000,1000]}}),bridge=new SceneTransformSpatialBridge({kind:"octree",target:index});
 const tx=plan(graph,[{id:"create-box",type:"object.create-primitive",target:target("new-box"),name:"box",kind:"box" as const,color:"#1683ff"}]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");
 assert.equal(graph.has("new-box"),true);assert.equal(owner.get("new-box")?.kind,"box");assert.equal(owner.get("new-box")?.color,"#1683ff");
 bridge.apply(d.finalFlush!);
 assert.deepEqual(index.queryAabb({min:[-2,-2,-2],max:[2,2,2]}).ids,["new-box"]);
 assert.deepEqual(index.queryAabb({min:[3,-2,-2],max:[5,2,2]}).ids,[]);
 const {renderPacket,runtimePackage}=owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:graph.revision});
 assert.equal(runtimePackage.schemaVersion,1);assert.equal(runtimePackage.entrypoints.renderPacket,"scene.render");
 assert.deepEqual(runtimePackage.resources.map(entry=>entry.kind),["ibl-environment","render-packet"]);
 const packet=runtimePackage.payloads["scene.render"] as Record<string,unknown>;
 assert.deepEqual((packet.instances as Array<Record<string,unknown>>).map(instance=>instance.id),["new-box"]);
 assert.deepEqual((packet.geometries as Array<Record<string,unknown>>).map(geometry=>geometry.id),["primitive:box"]);
 assert.deepEqual((packet.materials as Array<Record<string,unknown>>).map(material=>material.id),["material:new-box"]);
 const vertices=(packet.geometries as Array<Record<string,unknown>>)[0]!.vertices as number[];
 assert.equal(vertices.length,144);
 for(let axis=0;axis<3;axis+=1){
  let min=Infinity,max=-Infinity;
  for(let offset=axis;offset<vertices.length;offset+=6){min=Math.min(min,vertices[offset]!);max=Math.max(max,vertices[offset]!);}
  assert.equal(min,-1);assert.equal(max,1);
 }
 assert.equal(renderPacket.instances[0]!.castShadow,true);
 cases.push("H-C7-P3 create-primitive hosts real box geometry into RuntimePackage v1 and consumes finalFlush spatial bounds");

});
it("H-C7-P3 delete-primitive releases ownership and clears spatial bounds after finalFlush", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 owner.createPrimitive({...primitiveStateFromCommand({target:target("victim"),name:"victim",kind:"box",color:"#ff8844"})});
 graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});graph.flush();
 const index=new LooseOctreeIndex<string>({bounds:{min:[-1000,-1000,-1000],max:[1000,1000,1000]}});
 const createTx=plan(graph,[{id:"create-box",type:"object.create-primitive",target:target("new-box"),name:"box",kind:"box" as const,color:"#1683ff"}]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:createTx.id,baseRevision:createTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(createTx,d)).status,"committed");
 const deleteTx=plan(graph,[{id:"delete-box",type:"object.delete-primitive",target:target("new-box")}]);
 const d2=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:deleteTx.id,baseRevision:deleteTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 const outcome=await commitSceneCommandTransaction(deleteTx,d2);
 assert.equal(outcome.status,"committed");assert.deepEqual([...d2.finalFlush!.removedNodeIds],["new-box"]);
 new SceneTransformSpatialBridge({kind:"octree",target:index}).apply(d2.finalFlush!);
 assert.equal(graph.has("new-box"),false);assert.equal(owner.has("new-box"),false);
 assert.deepEqual(index.queryAabb({min:[-2,-2,-2],max:[2,2,2]}).ids,[]);
 const packet=owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:graph.revision}).runtimePackage.payloads["scene.render"] as Record<string,unknown>;
 assert.deepEqual((packet.instances as Array<Record<string,unknown>>).map(instance=>instance.id),["victim"]);
 assert.deepEqual((packet.geometries as Array<Record<string,unknown>>).map(geometry=>geometry.id),["primitive:box"]);
 assert.equal(graph.has("victim"),true);assert.equal(owner.has("victim"),true);
 cases.push("H-C7-P3 delete-primitive releases ownership + clears spatial bounds after finalFlush, unrelated primitive intact");

});
it("H-C7-P3 mixed batch failure compensates the primitive owner atomically without publishing a flush", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();graph.flush();
 const tx=plan(graph,[
  {id:"create-ok",type:"object.create-primitive",target:target("mixed-box"),name:"box",kind:"box" as const,color:"#1683ff"},
  {id:"create-dup",type:"object.create-primitive",target:target("mixed-box"),name:"dup",kind:"sphere" as const,color:"#00ff00"},
 ]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"rolled-back");
 assert.equal(graph.has("mixed-box"),false);assert.equal(owner.has("mixed-box"),false);
 assert.equal(d.finalFlush,undefined);
 cases.push("H-C7-P3 mixed batch failure compensates owner registry and graph atomically");

});
it("H-C7-P3 SDK cancellation after apply restores created and deleted primitives via inverse operators", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 const victim={...primitiveStateFromCommand({target:target("victim"),name:"victim",kind:"box",color:"#ff8844"})};
 owner.createPrimitive(victim);
 graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});graph.flush();
 const tx=plan(graph,[
  {id:"create-box",type:"object.create-primitive",target:target("new-box"),name:"box",kind:"box" as const,color:"#1683ff"},
  {id:"delete-victim",type:"object.delete-primitive",target:target("victim")},
 ]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 const controller=new AbortController();
 const outcome=await commitSceneCommandTransaction(tx,{readRevision:()=>d.readRevision(),apply:commands=>{const applied=d.apply(commands);controller.abort();return applied;},rollback:()=>d.rollback()},controller.signal);
 assert.equal(outcome.status,"rolled-back");
 assert.equal(graph.has("new-box"),false);assert.equal(owner.has("new-box"),false);
 assert.equal(graph.has("victim"),true);assert.equal(graph.getNode("victim")!.worldMatrix[12],5);
 assert.equal(owner.get("victim")?.color,"#ff8844");
 assert.equal(d.rollback(),graph.revision);
 cases.push("H-C7-P3 SDK cancellation after apply restores created removal and deleted subtree+resources");

});
it("H-C7-P3 locked, foreign-node and absent-owner primitive commands refuse fail-closed", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 owner.createPrimitive({...primitiveStateFromCommand({target:target("locked-box"),name:"locked",kind:"box",color:"#888888"}),locked:true});
 graph.create({id:"locked-box",localTransform:transform(0),localBounds:owner.localBounds("box")});
 graph.create({id:"raw-graph-node",localTransform:transform(1),localBounds:owner.localBounds("box")});graph.flush();
 const deleteLocked=plan(graph,[{id:"delete-locked",type:"object.delete-primitive",target:target("locked-box")}]);
 const d1=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:deleteLocked.id,baseRevision:deleteLocked.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(deleteLocked,d1)).status,"rolled-back");
 assert.equal(graph.has("locked-box"),true);assert.equal(owner.has("locked-box"),true);
 const deleteForeign=plan(graph,[{id:"delete-foreign",type:"object.delete-primitive",target:target("raw-graph-node")}]);
 const d2=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:deleteForeign.id,baseRevision:deleteForeign.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(deleteForeign,d2)).status,"rolled-back");
 assert.equal(graph.has("raw-graph-node"),true);
 const createNoOwner=plan(graph,[{id:"create-box",type:"object.create-primitive",target:target("new-box"),name:"box",kind:"box" as const,color:"#1683ff"}]);
 const d3=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:createNoOwner.id,baseRevision:createNoOwner.baseRevision,parser:{parse:parseSceneCommand}});
 assert.equal((await commitSceneCommandTransaction(createNoOwner,d3)).status,"rolled-back");
 assert.equal(graph.has("new-box"),false);
 cases.push("H-C7-P3 locked/foreign-node/absent-owner primitive commands refuse fail-closed");

});
it("H-C7-P3 touch-unlock: transform/visibility/parent on port primitives project back and recompile", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();graph.flush();
 const index=new LooseOctreeIndex<string>({bounds:{min:[-1000,-1000,-1000],max:[1000,1000,1000]}}),bridge=new SceneTransformSpatialBridge({kind:"octree",target:index});
 const tx=plan(graph,[
  {id:"create-box",type:"object.create-primitive",target:target("new-box"),name:"box",kind:"box" as const,color:"#1683ff"},
  {id:"move",type:"object.set-transform",target:target("new-box"),position:[3,0,0],rotation:[0.3,0.8,-0.4],scale:[2,0.5,1.5]},
 ]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");
 bridge.apply(d.finalFlush!);
 // 触碰解锁:transform 已投影回 PrimitiveState,编译通过且实例矩阵与 graph 权威世界矩阵一致。
 const {renderPacket}=owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:graph.revision});
 assert.equal(renderPacket.instances.length,1);
 const instance=renderPacket.instances[0]!,node=graph.getNode("new-box")!;
 assert.equal(instance.transform.length,16);
 // 包实例 transform 是 Float32Array(f32),与 f64 graph 矩阵比对容差取 f32 精度量级。
 for(let index2=0;index2<16;index2+=1)assert.ok(Math.abs(instance.transform[index2]!-node.worldMatrix[index2]!)<1e-6,`matrix[${index2}] drift`);
 assert.deepEqual(index.queryAabb({min:[0,-2,-2],max:[4,2,2]}).ids,["new-box"]);
 // visibility 触碰:隐藏→编译通过且实例消失;显示→实例恢复。
 const hideTx=plan(graph,[{id:"hide",type:"object.set-visibility",target:target("new-box"),visible:false}]);
 const d2=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:hideTx.id,baseRevision:hideTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(hideTx,d2)).status,"committed");
 assert.equal(owner.get("new-box")!.visible,false);
 assert.equal(owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:graph.revision}).renderPacket.instances.length,0);
 const showTx=plan(graph,[{id:"show",type:"object.set-visibility",target:target("new-box"),visible:true}]);
 const d3=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:showTx.id,baseRevision:showTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(showTx,d3)).status,"committed");
 assert.equal(owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:graph.revision}).renderPacket.instances.length,1);
 // parent 走 graph 层级:keepWorld 重算本地 TRS 后投影回 port,世界矩阵与资源不变。
 graph.create({id:"carrier",localTransform:transform(10)});graph.flush();
 const before=graph.getNode("new-box")!,worldBefore=[...before.worldMatrix];
 const parentTx=plan(graph,[{id:"reparent",type:"object.set-parent",target:target("new-box"),parentId:"carrier",keepWorldTransform:true}]);
 const d4=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:parentTx.id,baseRevision:parentTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(parentTx,d4)).status,"committed");
 const after=graph.getNode("new-box")!;
 assert.equal(after.parent,"carrier");
 // keepWorld 产物为 matrix kind 本地变换;投影分解须可无损还原(重组守卫在 port 内)。
 for(let axis=0;axis<16;axis+=1)assert.ok(Math.abs(after.worldMatrix[axis]!-worldBefore[axis]!)<1e-9);
 const repacked=owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:graph.revision}).renderPacket;
 assert.equal(repacked.instances.length,1);
 for(let index2=0;index2<16;index2+=1)assert.ok(Math.abs(repacked.instances[0]!.transform[index2]!-after.localMatrix[index2]!)<1e-6);
 assert.equal(owner.get("new-box")!.kind,"box");
 cases.push("H-C7-P3 touch-unlock: transform/visibility/parent project into PrimitiveState and recompile");

});
it("H-C7-P3 material.set consumes into PrimitiveState; unsupported domain refuses the whole batch atomically", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();graph.flush();
 const consumeTx=plan(graph,[
  {id:"create-box",type:"object.create-primitive",target:target("new-box"),name:"box",kind:"box" as const,color:"#1683ff"},
  {id:"material",type:"material.set",target:target("new-box"),patch:{color:"#ff8800",metalness:0.8,roughness:0.25}},
  {id:"neutral",type:"material.set",target:target("new-box"),patch:{normalScale:1,wireframe:false}},
 ],["studio.object","studio.material"]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:consumeTx.id,baseRevision:consumeTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(consumeTx,d)).status,"committed");
 const material=owner.get("new-box")!.material!;
 assert.deepEqual(material,{color:"#ff8800",metalness:0.8,roughness:0.25});
 const {renderPacket}=owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:graph.revision});
 const packetMaterial=renderPacket.materials[0]!;
 assert.equal(packetMaterial.metallic,0.8);assert.equal(packetMaterial.roughness,0.25);
 assert.deepEqual([...packetMaterial.baseColor],sceneHexToLinearRgb("#ff8800"));
 // 不支持域:wireframe=true 超出基础体编译路径,整批原子拒绝,状态不变。
 const unsupportedTx=plan(graph,[
  {id:"create-second",type:"object.create-primitive",target:target("second-box"),name:"box",kind:"box" as const,color:"#00ff00"},
  {id:"material-bad",type:"material.set",target:target("new-box"),patch:{wireframe:true}},
 ],["studio.object","studio.material"]);
 const d2=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:unsupportedTx.id,baseRevision:unsupportedTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(unsupportedTx,d2)).status,"rolled-back");
 assert.equal(graph.has("second-box"),false);assert.equal(owner.has("second-box"),false);
 assert.deepEqual(owner.get("new-box")!.material,{color:"#ff8800",metalness:0.8,roughness:0.25});
 assert.equal(d2.finalFlush,undefined);
 // 非 port 图元的 material.set 维持 fail-closed 拒绝。
 graph.create({id:"raw-node",localTransform:transform(1),localBounds:{min:[-1,-1,-1],max:[1,1,1]}});graph.flush();
 const foreignTx=plan(graph,[{id:"material-foreign",type:"material.set",target:target("raw-node"),patch:{color:"#123456"}}],["studio.object","studio.material"]);
 const d3=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:foreignTx.id,baseRevision:foreignTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(foreignTx,d3)).status,"rolled-back");
 cases.push("H-C7-P3 material.set consumes supported subset; unsupported domain refuses atomically; foreign target fail-closed");

});
it("H-C7-P3 SDK cancellation after synced touch restores PrimitiveState via inverse operators", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 const tx=plan(graph,[
  {id:"create-box",type:"object.create-primitive",target:target("new-box"),name:"box",kind:"box" as const,color:"#1683ff"},
 ],["studio.object","studio.material"]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");
 const touchTx=plan(graph,[
  {id:"move",type:"object.set-transform",target:target("new-box"),position:[5,0,0]},
  {id:"material",type:"material.set",target:target("new-box"),patch:{color:"#ff00ff",metalness:0.5}},
  {id:"hide",type:"object.set-visibility",target:target("new-box"),visible:false},
 ],["studio.object","studio.material"]);
 const d2=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:touchTx.id,baseRevision:touchTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 const controller=new AbortController();
 const outcome=await commitSceneCommandTransaction(touchTx,{readRevision:()=>d2.readRevision(),apply:commands=>{const applied=d2.apply(commands);controller.abort();return applied;},rollback:()=>d2.rollback()},controller.signal);
 assert.equal(outcome.status,"rolled-back");
 const restored=owner.get("new-box")!;
 assert.equal(restored.visible,true);assert.equal(restored.color,"#1683ff");assert.equal(restored.material,undefined);
 assert.deepEqual([restored.transform.position.x,restored.transform.position.y,restored.transform.position.z],[0,0,0]);
 assert.deepEqual([restored.transform.scale.x,restored.transform.scale.y,restored.transform.scale.z],[1,1,1]);
 assert.equal(graph.getNode("new-box")!.hidden,false);
 assert.equal(owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:graph.revision}).renderPacket.instances.length,1);
 assert.equal(d2.rollback(),graph.revision);
 cases.push("H-C7-P3 SDK cancellation after synced touch restores PrimitiveState exactly");

});
it("H-C7-P3 port keeps host-level divergence guard for unprojectable touches", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 owner.createPrimitive(primitiveStateFromCommand({target:target("guarded"),name:"box",kind:"box",color:"#888888"}));
 owner.markNodeDiverged("guarded");
 assert.equal(owner.isNodeDiverged("guarded"),true);
 assert.throws(()=>owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:1}),/unsupported commands: guarded/);
 owner.clearNodeDiverged("guarded");
 assert.equal(owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:1}).renderPacket.instances.length,1);
 // 投影 API 对非 port 图元拒绝;markNodeDiverged 对未知 id 静默忽略(与批 1 一致)。
 assert.throws(()=>owner.syncVisibility("missing",false),/not owned/);
 assert.throws(()=>owner.syncMaterial("missing",{color:"#123456"}),/not owned/);
 const absent=primitiveStateFromCommand({target:target("guarded"),name:"box",kind:"box",color:"#888888"});
 assert.throws(()=>owner.applyPrimitiveState("missing",{primitive:absent,diverged:false}),/does not exist/);
 owner.markNodeDiverged("unknown-id");
 cases.push("H-C7-P3 port keeps host-level divergence guard and rejects projections for unowned ids");

});
it("H-C7-P3 camera.set/fly-to consume through the host camera port; absent port refuses fail-closed", async () => {

 const camera=new SceneCameraOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 graph.create({id:"cam-box",localTransform:transform(6),localBounds:{min:[-1,-1,-1],max:[1,1,1]}});graph.flush();
 const caps=["studio.object","studio.camera"];
 const tx=plan(graph,[{id:"cam",type:"camera.set",sceneId:"world",position:[10,8,6],target:[0,0,0],near:0.5,far:500,fov:55}],caps);
 const mk=(txPlan:ReturnType<typeof plan>)=>new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:txPlan.id,baseRevision:txPlan.baseRevision,parser:{parse:parseSceneCommand},cameraPort:camera});
 const d=mk(tx);
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");
 // camera.set 消费完整 pose;graph 未被触碰(flush 无节点变更)。
 assert.deepEqual(camera.snapshot().pose,{position:[10,8,6],target:[0,0,0],near:0.5,far:500,fov:55});
 assert.equal(d.finalFlush!.changedNodeIds.length,0);assert.equal(d.finalFlush!.removedNodeIds.length,0);
 // fly-to(object 引用):driver 经 graph 解析世界矩阵平移为 focus-object 意图。
 const flyTx=plan(graph,[{id:"fly",type:"camera.fly-to",sceneId:"world",target:target("cam-box"),durationMs:0}],caps);
 const d2=mk(flyTx);
 assert.equal((await commitSceneCommandTransaction(flyTx,d2)).status,"committed");
 const intent=camera.snapshot().lastIntent!;
 assert.equal(intent.kind,"focus-object");
 assert.deepEqual(intent.kind==="focus-object"?intent.worldPosition:null,[6,0,0]);
 assert.deepEqual(intent.kind==="focus-object"?intent.objectId:null,"cam-box");
 assert.deepEqual(camera.snapshot().pose!.target,[6,0,0]);
 // 逆算子:回滚恢复 camera.set 的 before pose(即时终点态可精确撤销)。
 d2.rollback();
 assert.deepEqual(camera.snapshot().pose,{position:[10,8,6],target:[0,0,0],near:0.5,far:500,fov:55});
 // 缺 cameraPort fail-closed:相机命令拒绝,宿主相机与 graph 状态零变化。
 const noPortTx=plan(graph,[{id:"cam2",type:"camera.set",sceneId:"world",position:[1,1,1],target:[0,0,0]}],caps);
 const d3=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:noPortTx.id,baseRevision:noPortTx.baseRevision,parser:{parse:parseSceneCommand}});
 assert.equal((await commitSceneCommandTransaction(noPortTx,d3)).status,"rolled-back");
 assert.deepEqual(camera.snapshot().pose,{position:[10,8,6],target:[0,0,0],near:0.5,far:500,fov:55});
 // driver 侧 scene 守卫(防御纵深:SDK prepare 已拦,直调 driver 同样拦)。
 const d4=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:"tx:direct",baseRevision:graph.revision,parser:{parse:parseSceneCommand},cameraPort:camera});
 assert.throws(()=>d4.apply([{id:"cam3",type:"camera.set",sceneId:"other",position:[1,1,1],target:[0,0,0]}]),/scene/);
 cases.push("H-C7-P3 camera.set/fly-to consume via host camera port; absent port and scene mismatch refuse fail-closed; rollback restores pose");

});
it("H-C7-P3 camera.fly-to resolves scene/position targets and honestly refuses tweened durations", async () => {

 const camera=new SceneCameraOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 graph.create({id:"far-box",localTransform:transform(6),localBounds:{min:[-1,-1,-1],max:[1,1,1]}});
 graph.create({id:"near-box",localTransform:transform(0),localBounds:{min:[-1,-1,-1],max:[1,1,1]}});graph.flush();
 const caps=["studio.object","studio.camera"];
 const mk=(txPlan:ReturnType<typeof plan>)=>new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:txPlan.id,baseRevision:txPlan.baseRevision,parser:{parse:parseSceneCommand},cameraPort:camera});
 // scene 引用→fit-scene:全节点世界包围盒并集 [-1..7]x[-1..1]x[-1..1] 中心 [3,0,0]。
 const fitTx=plan(graph,[{id:"fit",type:"camera.fly-to",sceneId:"world",target:{kind:"scene",sceneId:"world"},durationMs:0}],caps);
 const d=mk(fitTx);
 assert.equal((await commitSceneCommandTransaction(fitTx,d)).status,"committed");
 const fit=camera.snapshot().lastIntent!;
 assert.equal(fit.kind,"fit-scene");assert.deepEqual(fit.kind==="fit-scene"?fit.worldCenter:null,[3,0,0]);
 // position 目标→look-at。
 const lookTx=plan(graph,[{id:"look",type:"camera.fly-to",sceneId:"world",target:{position:[0,5,0]},durationMs:0}],caps);
 const d1=mk(lookTx);
 assert.equal((await commitSceneCommandTransaction(lookTx,d1)).status,"committed");
 const look=camera.snapshot().lastIntent!;
 assert.equal(look.kind,"look-at");assert.deepEqual(look.kind==="look-at"?look.target:null,[0,5,0]);
 assert.deepEqual(camera.snapshot().pose!.target,[0,5,0]);
 // durationMs>0 如实拒绝(带 port 也拒):时长缓动属宿主 Tween 播放层,事务只消费即时终点态。
 const tweenTx=plan(graph,[{id:"tween",type:"camera.fly-to",sceneId:"world",target:{position:[1,1,1]},durationMs:250}],caps);
 const d2=mk(tweenTx);
 assert.equal((await commitSceneCommandTransaction(tweenTx,d2)).status,"rolled-back");
 assert.deepEqual(camera.snapshot().pose!.target,[0,5,0]);assert.equal(d2.finalFlush,undefined);
 // 不存在的 object 目标如实拒绝。
 const missTx=plan(graph,[{id:"miss",type:"camera.fly-to",sceneId:"world",target:target("ghost"),durationMs:0}],caps);
 const d3=mk(missTx);
 assert.equal((await commitSceneCommandTransaction(missTx,d3)).status,"rolled-back");
 assert.deepEqual(camera.snapshot().pose!.target,[0,5,0]);
 cases.push("H-C7-P3 camera.fly-to resolves fit-scene/look-at/object targets; tweened durations and missing targets refuse honestly");

});
it("H-C7-P3 delete-primitive consumes selectionSets/rootLayerOrder references via the cleanup port", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 owner.createPrimitive({...primitiveStateFromCommand({target:target("victim"),name:"victim",kind:"box",color:"#ff8844"})});
 owner.createPrimitive({...primitiveStateFromCommand({target:target("keeper"),name:"keeper",kind:"box",color:"#00ff00"})});
 graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});
 graph.create({id:"keeper",localTransform:transform(-5),localBounds:owner.localBounds("box")});graph.flush();
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"组一",objectIds:["victim","keeper"]},{id:"g2",name:"组二",objectIds:["victim"]}],
  rootLayerOrder:[{kind:"object",id:"keeper"},{kind:"group",id:"g1"},{kind:"object",id:"victim"}],
 }});
 const tx=plan(graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner,referenceCleanup:refs});
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");
 // 第一子集消费:选择集摘 objectId 保留集合本身;rootLayerOrder 过滤对象根行、组行保留。
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds,["keeper"]);
 assert.deepEqual(refs.state.selectionSets[1]!.objectIds,[]);
 assert.deepEqual(refs.state.rootLayerOrder,[{kind:"object",id:"keeper"},{kind:"group",id:"g1"}]);
 assert.equal(owner.has("victim"),false);assert.equal(graph.has("victim"),false);
 assert.equal(owner.has("keeper"),true);assert.equal(graph.has("keeper"),true);
 const packet=owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:graph.revision}).renderPacket;
 assert.deepEqual(packet.instances.map(instance=>instance.id),["keeper"]);
 cases.push("H-C7-P3 delete-primitive prunes selectionSets/rootLayerOrder references; sets survive emptied; package follows");

});
it("H-C7-P3 SDK cancellation restores pruned references through the inverse operators", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 owner.createPrimitive({...primitiveStateFromCommand({target:target("victim"),name:"victim",kind:"box",color:"#ff8844"})});
 owner.createPrimitive({...primitiveStateFromCommand({target:target("keeper"),name:"keeper",kind:"box",color:"#00ff00"})});
 graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});
 graph.create({id:"keeper",localTransform:transform(-5),localBounds:owner.localBounds("box")});graph.flush();
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"组一",objectIds:["victim","keeper"]}],
  rootLayerOrder:[{kind:"object",id:"victim"}],
 }});
 const tx=plan(graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner,referenceCleanup:refs});
 const controller=new AbortController();
 const outcome=await commitSceneCommandTransaction(tx,{readRevision:()=>d.readRevision(),apply:commands=>{const applied=d.apply(commands);controller.abort();return applied;},rollback:()=>d.rollback()},controller.signal);
 assert.equal(outcome.status,"rolled-back");
 // 引用容器按 before 态精确恢复;图元与节点同样恢复。
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds,["victim","keeper"]);
 assert.deepEqual(refs.state.rootLayerOrder,[{kind:"object",id:"victim"}]);
 assert.equal(owner.has("victim"),true);assert.equal(graph.has("victim"),true);
 assert.equal(d.rollback(),graph.revision);
 cases.push("H-C7-P3 SDK cancellation restores pruned references + deleted primitive + subtree via inverse operators");

});
it("H-C7-P3 assetBindings remains the deletion reject path after animation/simulation consumption landed", async () => {

 const variants=[
  {label:"assetBindings",containers:{selectionSets:[{id:"g1",name:"g",objectIds:["victim"]}],rootLayerOrder:[] as Array<{kind:"object";id:string}>,
   assetBindings:[{id:"asset-1",sceneObjectId:"victim",objectName:"victim",modelId:"victim",deviceId:"pump-01",confidence:1,confirmedAt:"2026-10-02T00:00:00.000Z"}]}},
 ];
 for(const variant of variants){
  const owner=new ScenePrimitiveOwner({sceneId:"world"});
  const graph=new SceneTransformGraph<string>();
  owner.createPrimitive({...primitiveStateFromCommand({target:target("victim"),name:"victim",kind:"box",color:"#ff8844"})});
  owner.createPrimitive({...primitiveStateFromCommand({target:target("keeper"),name:"keeper",kind:"box",color:"#00ff00"})});
  graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});
  graph.create({id:"keeper",localTransform:transform(-5),localBounds:owner.localBounds("box")});graph.flush();
  const refs=new SceneReferenceRegistry({sceneId:"world",containers:variant.containers as never});
  const tx=plan(graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
  const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner,referenceCleanup:refs});
  assert.equal((await commitSceneCommandTransaction(tx,d)).status,"rolled-back",variant.label);
  // 绑定引用存在 → 删除整批拒绝,引用/图元/节点状态零变化(不部分清理)。
  assert.equal(owner.has("victim"),true,variant.label);assert.equal(graph.has("victim"),true,variant.label);
  assert.deepEqual(JSON.parse(JSON.stringify(refs.state)),JSON.parse(JSON.stringify(variant.containers)),variant.label);
 }
 cases.push("H-C7-P3 assetBindings keeps the batch-reject deletion semantics (animation/simulationEntities moved to consumption; see batch 6)");

});
it("H-C7-P3 save/reopen: port primitives roundtrip a SceneSnapshot with byte-identical projection and stay editable", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();graph.flush();
 const tx=plan(graph,[
  {id:"create-box",type:"object.create-primitive",target:target("re-box"),name:"box",kind:"box" as const,color:"#1683ff"},
  {id:"move",type:"object.set-transform",target:target("re-box"),position:[3,0,0],rotation:[0.3,0.8,-0.4],scale:[2,0.5,1.5]},
  {id:"material",type:"material.set",target:target("re-box"),patch:{color:"#ff8800",metalness:0.8,roughness:0.25}},
  {id:"create-hidden",type:"object.create-primitive",target:target("hidden-box"),name:"hidden",kind:"sphere" as const,color:"#00ff00"},
  {id:"hide",type:"object.set-visibility",target:target("hidden-box"),visible:false},
 ],["studio.object","studio.material"]);
 const d=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:owner});
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");
 const snapshot=owner.snapshotScene();
 assert.equal(snapshot.schemaVersion,1);assert.deepEqual(snapshot.models,[]);
 // 真实序列化往返:JSON 落盘→重开。
 const reopened=restoreSceneFromSnapshot({snapshot:JSON.parse(JSON.stringify(snapshot)),sceneId:"world"});
 assert.equal(reopened.owner.list().length,2);assert.equal(reopened.graph.size,2);
 assert.deepEqual(reopened.owner.get("re-box")!.material,{color:"#ff8800",metalness:0.8,roughness:0.25});
 const original=owner.get("re-box")!,restored=reopened.owner.get("re-box")!;
 assert.deepEqual(restored.transform.position,original.transform.position);
 for(const axis of ["x","y","z"] as const)assert.ok(Math.abs(restored.transform.rotation[axis]-original.transform.rotation[axis])<1e-12,`rotation.${axis}`);
 assert.deepEqual(restored.transform.scale,original.transform.scale);
 // hidden 图元:graph 节点 hidden 权威态恢复,编译投影同样不可见。
 assert.equal(reopened.graph.getNode("hidden-box")!.hidden,true);
 assert.equal(reopened.owner.get("hidden-box")!.visible,false);
 // 重开投影与保存前逐字节一致:同 revision 输入下包哈希相等。
 const hashBefore=owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:42}).runtimePackage.packageHash.value;
 const hashReopened=reopened.owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:42}).runtimePackage.packageHash.value;
 assert.equal(hashReopened,hashBefore);
 // 重开场景可继续作者:变换/材质事务提交并投影回 port,图元保持可编译。
 const editTx=plan(reopened.graph,[
  {id:"move-again",type:"object.set-transform",target:target("re-box"),position:[9,1,0]},
  {id:"material-again",type:"material.set",target:target("re-box"),patch:{roughness:0.1}},
 ],["studio.object","studio.material"]);
 const d2=new SceneGraphTransactionDriver(reopened.graph,{sceneId:"world",transactionId:editTx.id,baseRevision:editTx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:reopened.owner});
 assert.equal((await commitSceneCommandTransaction(editTx,d2)).status,"committed");
 assert.equal(reopened.graph.getNode("re-box")!.worldMatrix[12],9);
 assert.equal(reopened.owner.get("re-box")!.material!.roughness,0.1);
 assert.equal(reopened.owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:reopened.graph.revision}).renderPacket.instances.length,1);
 // 非 1 schemaVersion 如实拒绝。
 assert.throws(()=>restoreSceneFromSnapshot({snapshot:{...snapshot,schemaVersion:2 as never},sceneId:"world"}),/schemaVersion/);
 cases.push("H-C7-P3 save/reopen: snapshot JSON roundtrip restores primitives/transforms/hidden byte-identically (package hash equal) and stays editable");

});
it("H-C7-P3 reopened scene wires reference cleanup and keeps consuming deletions", async () => {

 const owner=new ScenePrimitiveOwner({sceneId:"world"});
 const graph=new SceneTransformGraph<string>();
 owner.createPrimitive({...primitiveStateFromCommand({target:target("victim"),name:"victim",kind:"box",color:"#ff8844"})});
 owner.createPrimitive({...primitiveStateFromCommand({target:target("keeper"),name:"keeper",kind:"box",color:"#00ff00"})});
 graph.create({id:"victim",localTransform:transform(5),localBounds:owner.localBounds("box")});
 graph.create({id:"keeper",localTransform:transform(-5),localBounds:owner.localBounds("box")});graph.flush();
 const refsBefore=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:[{id:"g1",name:"组一",objectIds:["victim"]}],
  rootLayerOrder:[{kind:"object",id:"keeper"},{kind:"object",id:"victim"}],
 }});
 const snapshot=owner.snapshotScene();
 snapshot.selectionSets=refsBefore.state.selectionSets;
 snapshot.rootLayerOrder=refsBefore.state.rootLayerOrder;
 const reopened=restoreSceneFromSnapshot({snapshot:JSON.parse(JSON.stringify(snapshot)),sceneId:"world"});
 // 重开链把快照引用容器接回清理 port(与产品保存重开链同形:引用随快照持久化)。
 const refs=new SceneReferenceRegistry({sceneId:"world",containers:{
  selectionSets:reopened.snapshot.selectionSets??[],rootLayerOrder:reopened.snapshot.rootLayerOrder??[],
 }});
 const tx=plan(reopened.graph,[{id:"del",type:"object.delete-primitive",target:target("victim")}]);
 const d=new SceneGraphTransactionDriver(reopened.graph,{sceneId:"world",transactionId:tx.id,baseRevision:tx.baseRevision,parser:{parse:parseSceneCommand},primitiveOwner:reopened.owner,referenceCleanup:refs});
 assert.equal((await commitSceneCommandTransaction(tx,d)).status,"committed");
 assert.deepEqual(refs.state.selectionSets[0]!.objectIds,[]);
 assert.deepEqual(refs.state.rootLayerOrder,[{kind:"object",id:"keeper"}]);
 assert.equal(reopened.owner.has("victim"),false);
 assert.deepEqual(reopened.owner.compileRuntimePackage({packageId:"scene.owner-pkg",revision:reopened.graph.revision}).renderPacket.instances.map(instance=>instance.id),["keeper"]);
 cases.push("H-C7-P3 reopened scene wires snapshot reference containers back into cleanup and keeps consuming deletions");

});
