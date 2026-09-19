import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsEmissiveStrength, type EmissiveStrength } from "@gltf-transform/extensions";
import { expect, it } from "vitest";
import { giFixture } from "../../scripts/gi-bake-fixture";
import { bakeWebLightmap, type WebLightmapOptions } from "./lightmapBaker";
const options: WebLightmapOptions = {resolution:256,strength:1,ambient:.3,ambientColor:"#ffffff",ambientOcclusion:false,aoSamples:4,
  shadows:false,shadowSamples:1,indirectSamples:4,denoise:false,lights:[{id:"sun",name:"sun",type:"directional",enabled:true,color:"#ffffff",intensity:2,
    direction:[1,1,1],position:[5,5,5],range:100}]};
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXsAAAAASUVORK5CYII="),c=>c.charCodeAt(0));
it("builds acceleration when only GI is enabled and retains red and neutral indirect light",async()=>{
  const run=async(indirectSamples:0|4)=>{const images:Uint8ClampedArray[]=[];await bakeWebLightmap(giFixture(),{...options,indirectSamples},undefined,async pixels=>{images.push(pixels.slice());return png;});return images[1]!;};
  const off=await run(0),on=await run(4);
  expect(off.some((value,i)=>i%4!==3&&value>0)).toBe(false);
  let changed=0,red=0,neutral=0;
  for(let i=0;i<on.length;i+=4){if(on[i]!+on[i+1]!+on[i+2]!>0)changed++;if(on[i]!>on[i+1]!+10)red++;if(on[i]!>0&&Math.abs(on[i]!-on[i+1]!)<2)neutral++;}
  expect(changed).toBeGreaterThan(100);expect(red).toBeGreaterThan(100);expect(neutral).toBeGreaterThan(100);
});
it("bakes shared meshes at their own world locations into disjoint atlas regions",async()=>{
  const document = giFixture(), scene = document.getRoot().listScenes()[0]!;
  const near = scene.listChildren()[0]!, far = document.createNode("far floor").setMesh(near.getMesh()).setTranslation([100,0,0]);
  scene.addChild(far);
  const images: Uint8ClampedArray[] = [];
  const result = await bakeWebLightmap(document, options, undefined, async pixels => {images.push(pixels.slice());return png;});
  expect(result.primitives).toBe(4);
  const nearUv=near.getMesh()!.listPrimitives()[0]!.getAttribute("TEXCOORD_1")!;
  const farUv=far.getMesh()!.listPrimitives()[0]!.getAttribute("TEXCOORD_1")!;
  expect(nearUv).not.toBe(farUv);
  const energy = (uv: typeof nearUv) => {
    const values = uv.getArray()!, xs: number[] = [], ys: number[] = [];
    for(let index=0;index<values.length;index+=2){xs.push(values[index]!*255);ys.push((1-values[index+1]!)*255);}
    let sum=0;
    for(let y=Math.ceil(Math.min(...ys))+1;y<Math.floor(Math.max(...ys))-1;y++)
      for(let x=Math.ceil(Math.min(...xs))+1;x<Math.floor(Math.max(...xs))-1;x++)sum+=images[1]![(y*256+x)*4]!;
    return sum;
  };
  expect(energy(nearUv)).toBeGreaterThan(1000);expect(energy(farUv)).toBe(0);
  const io=new WebIO().registerExtensions(ALL_EXTENSIONS),restored=await io.readBinary(await io.writeBinary(document));
  const restoredFar=restored.getRoot().listNodes().find(node=>node.getName()==="far floor")!;
  expect(restoredFar.getTranslation()).toEqual([100,0,0]);
  expect(restoredFar.getMesh()).not.toBe(restored.getRoot().listScenes()[0]!.listChildren()[0]!.getMesh());
});
it("round-trips HDR emissive strength and UV1 through a real GLB",async()=>{
  const document=giFixture();document.getRoot().listMaterials()[0]!.setEmissiveFactor([1,1,1]);
  // 正式 I/O 注册同一 ALL_EXTENSIONS；用已有标准扩展保留高于 1 的能量。
  const material=document.getRoot().listMaterials()[0]!;
  material.setExtension("KHR_materials_emissive_strength",document.createExtension(KHRMaterialsEmissiveStrength).createEmissiveStrength().setEmissiveStrength(4));
  const result=await bakeWebLightmap(document,{...options,indirectSamples:0,strength:0},undefined,async()=>png);
  expect(result.emissiveStrength).toBe(4);
  const io=new WebIO().registerExtensions(ALL_EXTENSIONS),restored=await io.readBinary(await io.writeBinary(document));
  expect(restored.getRoot().listMaterials()[0]!.getExtension<EmissiveStrength>("KHR_materials_emissive_strength")!.getEmissiveStrength()).toBe(4);
  expect(restored.getRoot().listMaterials()[0]!.getEmissiveTextureInfo()!.getTexCoord()).toBe(1);
});
