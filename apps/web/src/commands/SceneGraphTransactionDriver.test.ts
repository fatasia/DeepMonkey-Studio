import { it } from "vitest";
import assert from "node:assert/strict";
import { SceneTransformGraph } from "@bim-studio/deep-engine/scene";
import { SceneTransformSpatialBridge } from "@bim-studio/deep-engine/scene";
import type { SceneTransformFlushResult } from "@bim-studio/deep-engine/scene";
import { LooseOctreeIndex } from "@bim-studio/deep-engine";
import { SceneGraphTransactionDriver } from "./SceneGraphTransactionDriver";
import { ScenePrimitiveOwner, primitiveStateFromCommand, restoreSceneFromSnapshot } from "./ScenePrimitiveOwnerPort";
import { SceneGraphHistoryBridge } from "./SceneGraphHistoryBridge";
import { SceneCameraOwner, type SceneCameraPort, type SceneCameraPose } from "./SceneCameraPort";
import { SceneReferenceRegistry, SceneReferenceResolutionError, resolveSceneReferenceIntegrity } from "./SceneReferenceCleanupPort";
import { assembleCameraFlyTween, playCameraFlyTween } from "./SceneCameraFlyTween";
import type { SceneAssetBindingState } from "@bim-studio/contracts";
import { commitSceneCommandTransaction, prepareSceneCommandTransaction } from "@bim-studio/scene-sdk";
import { parseSceneCommand, validateSceneCommand } from "@bim-studio/scene-sdk";
import { SceneCommandExecutor } from "../behavior/SceneCommandExecutor";
import { sceneHexToLinearRgb } from "../delivery/sceneNeutralAppearance";
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

import type { ModelKeyframe, SceneAnimationState, SimulationEntityState } from "@bim-studio/contracts";

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

