import * as THREE from "three";
import { SceneTransformGraph } from "../src/scene/index.js";
import { ThreeProjectionBridge, projectThreeWorldLights, threeRenderView } from "../src/threeBridge/index.js";
import { prepareSceneCommandTransaction, commitSceneCommandTransaction, parseSceneCommand } from "../../scene-sdk/src/index.js";
import { SceneGraphTransactionDriver } from "../../../apps/web/src/commands/SceneGraphTransactionDriver.js";

// Run with repository tsx. Existing Three bridges perform the supported mappings.
const scene=new THREE.Scene(),geometryRoot=new THREE.Group(),left=new THREE.Group(),right=new THREE.Group();
left.position.x=-2;right.position.x=4;geometryRoot.add(left,right);scene.add(geometryRoot);
const box=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshStandardMaterial({color:"#ff8000",metalness:.2,roughness:.7}));
const sphere=new THREE.Mesh(new THREE.SphereGeometry(.5,16,8),new THREE.MeshStandardMaterial({color:"#20a0ff",metalness:1,roughness:.3}));
left.add(box);right.add(sphere);
const sun=new THREE.DirectionalLight("#ffffff",2);sun.position.set(3,5,2);scene.add(sun,sun.target);
const fill=new THREE.PointLight("#a0c0ff",4,12,2);fill.position.set(-3,2,4);scene.add(fill);
const camera=new THREE.PerspectiveCamera(50,16/9,.1,100);camera.position.set(8,6,12);camera.lookAt(0,0,0);scene.add(camera);scene.updateMatrixWorld(true);
const graph=new SceneTransformGraph<string>(),bindings=new Map<THREE.Object3D,string>([[left,"left"],[right,"right"],[box,"box"],[sphere,"sphere"]]);
for(const [object,id] of bindings)graph.create({id,parent:object.parent?bindings.get(object.parent)??null:null,localTransform:{kind:"matrix",matrix:[...object.matrix.elements] as unknown as import("../src/scene/index.js").SceneMatrix4}});
graph.flush();
const bridge=new ThreeProjectionBridge({hooks:{objectBeforeRender:THREE.Object3D.prototype.onBeforeRender,objectAfterRender:THREE.Object3D.prototype.onAfterRender,objectBeforeShadow:THREE.Object3D.prototype.onBeforeShadow,objectAfterShadow:THREE.Object3D.prototype.onAfterShadow,materialBeforeRender:THREE.Material.prototype.onBeforeRender,materialBeforeCompile:THREE.Material.prototype.onBeforeCompile,materialProgramCacheKey:THREE.Material.prototype.customProgramCacheKey},authorTransformResolver:object=>{const id=bindings.get(object as THREE.Object3D);return id?graph.getNode(id)!.worldMatrix:undefined;}});
const before=bridge.project(geometryRoot,{cameraLayerMask:1});if(!before.ok)throw Error(JSON.stringify(before.issues));before.acknowledge();
const prepared=prepareSceneCommandTransaction({id:"migration:parent",sceneId:"world",baseRevision:graph.revision,module:{id:"example",permissions:["scene.write"],capabilities:["studio.object"]},commands:[{id:"move-box",type:"object.set-parent",target:{kind:"object",sceneId:"world",objectId:"box"},parentId:"right",keepWorldTransform:false}]});
if(prepared.status!=="prepared")throw Error(JSON.stringify(prepared.issues));
const driver=new SceneGraphTransactionDriver(graph,{sceneId:"world",transactionId:prepared.plan.id,baseRevision:prepared.plan.baseRevision,parser:{parse:parseSceneCommand}});
const outcome=await commitSceneCommandTransaction(prepared.plan,driver);if(outcome.status!=="committed")throw Error(JSON.stringify(outcome));
const after=bridge.project(geometryRoot,{cameraLayerMask:1});if(!after.ok)throw Error(JSON.stringify(after.issues));
const lights=projectThreeWorldLights(scene,{cameraLayerMask:1});if(!lights.ok)throw Error(JSON.stringify(lights.issues));
const view=threeRenderView({camera,target:[0,0,0],width:1280,height:720,pixelRatio:1,extent:20,background:[.02,.025,.04],floor:[.1,.1,.1],exposure:1,roughness:.5,lights:lights.lights});
// Explicit unsupported diagnostics: custom compilation hooks are not auto-migrated.
const material=box.material,original=material.onBeforeCompile;material.onBeforeCompile=()=>{};
const unsupported=bridge.project(geometryRoot,{cameraLayerMask:1});material.onBeforeCompile=original;
const beforeBox=before.packet.instances.find(instance=>bridge.sourceForInstanceId(instance.id)===box)!;
const afterBox=after.packet.instances.find(instance=>instance.id===beforeBox.id)!;
const report={outcome:outcome.status,geometryCount:after.packet.geometries.length,instanceCount:after.packet.instances.length,materialCount:after.packet.materials.length,beforeBoxX:beforeBox.transform[12],afterBoxX:afterBox.transform[12],authoritativeParent:graph.getNode("box")!.parent,originalThreeParentPreserved:box.parent===left,lightCounts:{directional:lights.lights.directional?.length??0,points:lights.lights.points?.length??0},view:{eye:view.eye,verticalFovRadians:view.verticalFovRadians},unsupported:unsupported.ok?[]:unsupported.issues.map(issue=>({feature:issue.feature,code:issue.code})),gpuExecuted:false};
console.log(JSON.stringify(report,null,2));
for(const mesh of [box,sphere]){mesh.geometry.dispose();mesh.material.dispose();}bridge.clear();
