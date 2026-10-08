import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";

const box=readFileSync(new URL("../../../../packages/deep-engine/lab/assets/Box.glb",import.meta.url));
function glb(extensions:Record<string,unknown>):Uint8Array {
  const length=box.readUInt32LE(12),source=JSON.parse(box.subarray(20,20+length).toString("utf8"));
  source.extensionsUsed=Object.keys(extensions); source.materials[0].extensions=extensions;
  source.materials[0].alphaMode="OPAQUE"; source.materials[0].pbrMetallicRoughness.baseColorFactor[3]=1;
  const json=Buffer.from(JSON.stringify(source)),padded=Buffer.alloc(Math.ceil(json.length/4)*4,0x20);
  json.copy(padded); const rest=box.subarray(20+length),header=Buffer.from(box.subarray(0,20));
  header.writeUInt32LE(20+padded.length+rest.length,8); header.writeUInt32LE(padded.length,12);
  return Buffer.concat([header,padded,rest]);
}
function scene():SceneSnapshot {
  return {schemaVersion:1,id:"physical",projectId:"p",name:"Physical",primitives:[],measurements:[],
    models:[{modelId:"i",assetModelId:"g",name:"Glass",visible:true,opacity:1,
      transform:{position:{x:0,y:0,z:0},rotation:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}}}],
    camera:{mode:"orbit",position:{x:0,y:1,z:5},target:{x:0,y:0,z:0}},createdAt:"",updatedAt:""};
}
const compile=(bytes:Uint8Array)=>compileSceneRuntimePackage(scene(),{packageId:"runtime.physical",packageVersion:"0.2.0",
  advancedMaterials:true,loadModel:async()=>bytes});

it("forwards advanced source import and publishes alpha1 transmission/specular through the actual Native package",async()=>{
  const result=await compile(glb({KHR_materials_transmission:{transmissionFactor:1},
    KHR_materials_specular:{specularFactor:.5,specularColorFactor:[2,.25,.75]}}));
  const packet=result.runtimePackage.payloads[result.runtimePackage.entrypoints.renderPacket] as unknown as {
    materials:Array<Record<string,unknown>>};
  expect(packet.materials[0]).toMatchObject({specularFactor:.5,specularColorFactor:[2,.25,.75],alphaMode:"OPAQUE",
    baseColorAlpha:1,extendedParameters:{transmission:{factor:1}}});
  expect(result.evidence.sourceAssets).toHaveLength(1);
});

it.each([
  ["KHR_materials_anisotropy",{anisotropyStrength:.5},"anisotropy.strength"],
  ["KHR_materials_iridescence",{iridescenceFactor:.5},"iridescence.factor"],
  ["KHR_materials_volume",{thicknessFactor:1},"volume.thickness"],
] as const)("retains exact unsupported Native rejection for %s",async(extension,parameters,path)=>{
  await expect(compile(glb({[extension]:parameters,
    ...(extension==="KHR_materials_volume" ? {KHR_materials_transmission:{transmissionFactor:1}} : {})})))
    .rejects.toThrow(path);
});

it("rejects source material loss when the caller explicitly selects the plain import profile",async()=>{
  const bytes=glb({KHR_materials_transmission:{transmissionFactor:1}});
  await expect(compileSceneRuntimePackage(scene(),{packageId:"plain.loss",packageVersion:"0.2.0",
    advancedMaterials:false,loadModel:async()=>bytes})).rejects.toThrow("源材质不能完整发布");
});
