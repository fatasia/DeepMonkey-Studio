import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { RepeatedAssetBatcher } from "./repeatedAssetBatcher";
import type { LoadedSceneModel } from "./viewerTypes";

function fixture(count = 100) {
  const root = new THREE.Group(), geometry = new THREE.BoxGeometry();
  const models: LoadedSceneModel[] = Array.from({length:count},(_,index)=> {
    const object = new THREE.Group(); object.position.set(index%10*3,0,Math.floor(index/10)*3);
    const mesh = new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:0x668899}));
    mesh.name = "device-panel"; mesh.userData = { modelId:`device-${index}`,layerNodeId:"root/0" };
    object.add(mesh); root.add(object);
    return {id:`device-${index}`,assetModelId:"shared-device",name:`设备${index}`,object,kind:"model",visible:true,opacity:1};
  });
  return {root,models,geometry,batcher:new RepeatedAssetBatcher(root)};
}

describe("repeated asset drawing",()=>{
  it("keeps shear transforms and custom shadow callbacks in the ordinary draw path", () => {
    const h = fixture(12);
    for (let index = 0; index < 4; index++) {
      h.models[index]!.object.scale.set(2, 1, 1);
      h.models[index]!.object.children[0]!.rotation.z = Math.PI / 4;
    }
    for (let index = 4; index < 8; index++) h.models[index]!.object.children[0]!.onBeforeShadow = () => undefined;
    for (let index = 8; index < 12; index++) h.models[index]!.object.children[0]!.onAfterShadow = () => undefined;
    h.batcher.begin(h.models);
    expect(h.batcher.statistics().sources).toBe(0);
    expect(h.models.every(model => model.object.children[0]!.visible)).toBe(true);
    h.batcher.dispose();
  });

  it("allows orthogonal nonuniform scale while testing transforms relative to the batch parent", () => {
    const h = fixture(4); h.root.scale.set(2, 1, 1); h.root.rotation.z = Math.PI / 5;
    for (const model of h.models) model.object.scale.set(2, 3, 4);
    h.batcher.begin(h.models); expect(h.batcher.statistics().sources).toBe(4);
    h.batcher.dispose();
  });
  it("replaces identical draws while preserving author identities and transforms",()=>{
    const h=fixture();
    h.batcher.begin(h.models);
    expect(h.batcher.statistics()).toEqual({sources:100,batches:1,avoidedDraws:99});
    const group=h.root.getObjectByName("helper:repeated-assets")!;
    const batch=group.children[0] as THREE.InstancedMesh;
    const matrix=new THREE.Matrix4(); batch.getMatrixAt(12,matrix);
    expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([6,0,3]);
    expect(h.models[12]!.object.children[0]!.visible).toBe(false);
    h.batcher.end();
    expect(h.root.getObjectByName("helper:repeated-assets")).toBeUndefined();
    expect(h.models.every(model=>model.object.children[0]!.visible)).toBe(true);
    expect(h.models[12]!.object.children[0]!.userData).toEqual({modelId:"device-12",layerNodeId:"root/0"});
    h.batcher.dispose();
  });

  it("reflects visibility, material edits and movement without rewriting the source hierarchy",()=>{
    const h=fixture(6), first=h.models[0]!.object.children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>;
    first.material.color.set("red"); h.models[1]!.object.visible=false;
    h.models[2]!.object.position.x=16;
    h.batcher.begin(h.models);
    expect(h.batcher.statistics().sources).toBe(4); expect(first.visible).toBe(true);
    h.batcher.end(); expect(h.models[1]!.object.visible).toBe(false);
    const raycaster=new THREE.Raycaster(new THREE.Vector3(16,0,10),new THREE.Vector3(0,0,-1));
    const hit=raycaster.intersectObject(h.models[2]!.object,true)[0]!;
    expect(hit.object.userData.modelId).toBe("device-2");
    h.batcher.dispose();
  });

  it("retains ordinary rendering for incompatible transparency, custom effects and negative scales",()=>{
    const h=fixture(12);
    for(let i=0;i<4;i++)(h.models[i]!.object.children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>).material.transparent=true;
    for(let i=4;i<8;i++)(h.models[i]!.object.children[0] as THREE.Mesh).onBeforeRender=()=>undefined;
    for(let i=8;i<12;i++)h.models[i]!.object.scale.x=-1;
    h.batcher.begin(h.models); expect(h.batcher.statistics().sources).toBe(0);
    h.batcher.end(); expect(h.models.every(model=>model.object.children[0]!.visible)).toBe(true);
    h.batcher.dispose();
  });

  it("partitions distant clusters and never frees source geometry or material",()=>{
    const h=fixture(8), dispose=vi.spyOn(h.geometry,"dispose");
    for(let i=4;i<8;i++)h.models[i]!.object.position.x+=1_000;
    h.batcher.begin(h.models); expect(h.batcher.statistics().batches).toBe(2);
    h.batcher.end(); h.batcher.dispose(); expect(dispose).not.toHaveBeenCalled();
  });

  it("restores ordinary draws when disabled and excludes material callbacks",()=>{
    const h=fixture(8);
    h.batcher.begin(h.models);
    h.batcher.setEnabled(false);
    expect(h.models.every(model=>model.object.children[0]!.visible)).toBe(true);
    h.batcher.begin(h.models);
    expect(h.batcher.statistics().sources).toBe(0);
    h.batcher.setEnabled(true);
    for(let i=0;i<4;i++)(h.models[i]!.object.children[0] as THREE.Mesh<THREE.BufferGeometry,THREE.MeshStandardMaterial>).material.onBeforeRender=()=>undefined;
    h.batcher.begin(h.models);
    expect(h.batcher.statistics().sources).toBe(4);
    h.batcher.dispose();
  });
});
