import { expect, it } from "vitest";
import { buildDeepRuntimePackage, validateDeepRuntimePackage } from "./index.js";
import { materializeRuntimeRenderPacket } from "./renderPacket.js";
import type { RenderPacket } from "../renderPacketTypes.js";

function source(): RenderPacket {
  return { geometries:[{id:"g",revision:1,vertices:new Float32Array([-1,-1,0,0,0,1,1,-1,0,0,0,1,0,1,0,0,0,1]),
    indices:new Uint32Array([0,1,2]),uv0:new Float32Array([0,0,1,0,0,1]),uv1:new Float32Array([1,0,0,0,1,1])}],
    materials:[{id:"m",baseColor:[1,1,1],metallic:0,roughness:.3,baseColorAlpha:1,alphaMode:"OPAQUE",
      specularFactor:.5,specularColorFactor:[2,.5,1],specularTexture:{texture:"strength"},
      specularColorTexture:{texture:"color",texCoord:1,offset:[.25,.5]},extendedParameters:{transmission:{factor:1}}}],
    instances:[{id:"i",geometry:"g",material:"m",transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}],
    textures:[{id:"strength",revision:1,width:1,height:1,semantic:"specular",data:new Uint8Array([255,255,255,64])},
      {id:"color",revision:1,width:1,height:1,semantic:"specularColor",data:new Uint8Array([128,64,255,255])}] };
}
const publish=(packet:RenderPacket)=>buildDeepRuntimePackage({packageId:"native.physical",packageVersion:"0.2.0",
  renderPacket:{id:"scene",revision:1,value:packet}});

it("publishes the source specular tuple and alpha1 transmission through the Native wire contract",()=>{
  const input=source(),before=structuredClone(input),result=publish(input);
  expect(validateDeepRuntimePackage(result).valid).toBe(true); expect(input).toEqual(before);
  const restored=materializeRuntimeRenderPacket(result.payloads.scene,"$.packet");
  expect(restored.materials[0]).toMatchObject({specularFactor:.5,specularColorFactor:[2,.5,1],
    specularTexture:{texture:"strength"},specularColorTexture:{texture:"color",texCoord:1,offset:[.25,.5]},
    alphaMode:"OPAQUE",baseColorAlpha:1,extendedParameters:{transmission:{factor:1}}});
  expect(restored.textures?.map(texture=>[texture.semantic,...texture.data])).toEqual([
    ["specular",255,255,255,64],["specularColor",128,64,255,255]]);
});

it.each(["missing-uv","wrong-semantic","factor-range","unknown-slot"])("retains closed Native validation: %s",kind=>{
  const input=source();
  if(kind==="missing-uv") delete (input.geometries[0] as {uv1?:Float32Array}).uv1;
  if(kind==="wrong-semantic") (input.textures![1] as {semantic:string}).semantic="baseColor";
  if(kind==="factor-range") (input.materials[0] as {specularFactor:number}).specularFactor=1.1;
  if(kind==="unknown-slot") (input.materials[0]!.specularTexture as unknown as {unknown:number}).unknown=1;
  expect(()=>publish(input)).toThrow();
});
