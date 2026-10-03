import * as THREE from "three";
import {describe,expect,it,vi} from "vitest";
import type {ModelTransform} from "@bim-studio/contracts";
import {ViewerEngine} from "./ViewerEngine";
import {makeSceneSnapshot} from "../controllers/sceneSnapshotFactory";
type Source=Parameters<typeof makeSceneSnapshot>[0];
const authored:ModelTransform={position:{x:3,y:0,z:-2},rotation:{x:.2,y:.3,z:.4},scale:{x:1.3,y:.8,z:-1}};
function fixture(kind:"primitive"|"model"="primitive"){
  const object=new THREE.Group();object.position.set(0,1,0);object.userData.primitiveKind="sphere";
  const model={id:"m",name:"restored",kind,object,visible:true,opacity:1};
  const engine=Object.create(ViewerEngine.prototype) as ViewerEngine;
  const store=new Map([["m",{position:{x:0,y:1,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}}]]);
  Object.assign(engine,{models:new Map([["m",model]]),authorModelTransforms:store,listModels:()=>[model],
    setVisible:vi.fn(),setOpacity:vi.fn(),applyLayerStates:vi.fn(),setModelLocked:vi.fn(),setCollisionEnabled:vi.fn(),setExplosion:vi.fn(),
    hasAnimation:()=>false,setSpatialAudioState:vi.fn(),syncFragmentsTransformState:vi.fn(),setIndustrialPrefabState:vi.fn(),
    getIndustrialPrefabState:()=>undefined,getSpatialAudioState:()=>undefined,getModelColor:()=>"#b09060",isModelLocked:()=>false,
    isCollisionEnabled:()=>false,getExplosionFactor:()=>0,getExplosionMode:()=>"radial",getMaterialState:()=>undefined,
    getModelMaterialOverride:()=>undefined,getModelColorOverride:()=>undefined,getModelRigState:()=>undefined,getRobotPose:()=>undefined,
    getLayerStates:()=>[],getModelEffects:()=>undefined,getPhysicsBodyState:()=>undefined,
    getCameraState:()=>({mode:"orbit",position:{x:0,y:0,z:3},target:{x:0,y:0,z:0}}),getCameraConstraints:()=>undefined,
    getNavigationSettings:()=>undefined,listAnnotations:()=>[],getClippingState:()=>({enabled:false}),getWeather:()=>"sunny",
    getGlobalLighting:()=>undefined,getSceneEnvironment:()=>undefined,getFloorStates:()=>undefined,getPostProcessing:()=>undefined,
    getPhysicsState:()=>undefined,getSceneAnimation:()=>undefined});
  const source={engine,project:{id:"p",models:[]},activeScene:{id:"s",createdAt:""},sceneName:"restored",sceneCoordinates:undefined,
    cameraViews:[],measurements:[],sceneDashboard:undefined,engineeringAnalysis:undefined,sceneDataBindings:[],sceneAssetBindings:[],
    sceneInteractions:[],selectionSets:[],primitiveColors:{current:new Map([["m","#b09060"]])}} as unknown as Source;
  return {engine,object,store,source,restore:(transform=structuredClone(authored))=>engine.applyModelState("m",{visible:true,opacity:1,transform})};
}
describe("restore synchronizes the existing author transform authority",()=>{
  it("restores the primitive transform into actual getModelTransform and primitiveState",()=>{
    const f=fixture();f.restore();expect(f.object.position.toArray()).toEqual([3,0,-2]);
    expect(f.engine.getModelTransform("m")).toEqual(authored);expect(f.engine.primitiveState("m","#b09060")!.transform).toEqual(authored);
  });
  it("actual makeSceneSnapshot consumes restored primitive coordinates",()=>{
    const f=fixture();f.restore();expect(makeSceneSnapshot(f.source)!.primitives[0]!.transform).toEqual(authored);
  });
  it("restored author input, reads and snapshots stay detached from Three projection changes",()=>{
    const f=fixture(),input=structuredClone(authored);f.restore(input);input.position.y=99;
    f.object.position.y=88;f.object.rotation.x=2;f.object.scale.x=8;
    const read=f.engine.getModelTransform("m")!;read.rotation.y=77;
    const snapshot=makeSceneSnapshot(f.source)!;snapshot.primitives[0]!.transform.scale.x=66;
    expect(f.engine.getModelTransform("m")).toEqual(authored);expect(makeSceneSnapshot(f.source)!.primitives[0]!.transform).toEqual(authored);
  });
  it("actual makeSceneSnapshot consumes restored imported model coordinates",()=>{
    const f=fixture("model");f.restore();expect(makeSceneSnapshot(f.source)!.models[0]!.transform).toEqual(authored);
  });
  it("a second restore replaces the prior author snapshot and missing ids add no cache entry",()=>{
    const f=fixture();f.restore();const next=structuredClone(authored);next.position.x=-5;f.restore(next);
    expect(f.engine.getModelTransform("m")).toEqual(next);f.engine.applyModelState("missing",{visible:true,opacity:1,transform:authored});
    expect(f.store.size).toBe(1);expect(f.engine.getModelTransform("missing")).toBeUndefined();
  });
});
