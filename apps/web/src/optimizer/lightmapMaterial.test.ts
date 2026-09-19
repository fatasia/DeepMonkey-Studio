import { Document } from "@gltf-transform/core";
import { KHRTextureTransform } from "@gltf-transform/extensions";
import { Vector3 } from "three";
import { expect, it, vi } from "vitest";
import { createLightmapMaterialSamplers, type LightmapPixels } from "./lightmapMaterial";
function fixture() {
  const doc = new Document(), buffer = doc.createBuffer(), texture = doc.createTexture().setImage(new Uint8Array([1])).setMimeType("image/png");
  const material = doc.createMaterial().setMetallicFactor(0).setBaseColorTexture(texture);
  const uv = doc.createAccessor().setType("VEC2").setBuffer(buffer).setArray(new Float32Array([.25,.5,.25,.5,.25,.5]));
  const primitive = doc.createPrimitive().setMaterial(material).setAttribute("TEXCOORD_0",uv);
  const pixels: LightmapPixels = { width: 2, height: 1, data: new Uint8ClampedArray([255,0,0,255,0,0,255,128]) };
  return { doc, buffer, material, primitive, texture, pixels };
}
async function sample(f: ReturnType<typeof fixture>) {
  const samplers = await createLightmapMaterialSamplers([f.primitive], async () => f.pixels), diffuse = new Vector3(), emission = new Vector3();
  const alpha = samplers.get(f.primitive)!([0,1,2],[1,0,0],diffuse,emission);return { diffuse, emission, alpha };
}
it("samples the actual texture UV and preserves original emissive material energy", async () => {
  const f = fixture();f.material.setEmissiveFactor([.1,.2,.3]);
  const result = await sample(f);expect(result.diffuse.toArray()).toEqual([1,0,0]);expect(result.emission.toArray()).toEqual([.1,.2,.3]);
});
it("honors texture transforms and alpha mask rather than tinting with an average texture", async () => {
  const f = fixture();f.material.getBaseColorTextureInfo()!.setExtension("KHR_texture_transform", f.doc.createExtension(KHRTextureTransform).createTransform().setOffset([.5,0]));
  f.material.setAlphaMode("MASK").setAlphaCutoff(.6);
  const result = await sample(f);expect(result.diffuse.toArray()).toEqual([0,0,1]);expect(result.alpha).toBe(0);
});
it("linearizes color texels before filtering and leaves metallic data linear", async () => {
  const f = fixture();f.pixels.data.set([128,128,128,255,128,128,128,255]);f.material.setMetallicRoughnessTexture(f.texture).setMetallicFactor(1);
  const result = await sample(f);expect(result.diffuse.x).toBeCloseTo(.2158605*(1-128/255),6);expect(result.diffuse.y).toBe(result.diffuse.x);
});
it("applies linear vertex colors and caches shared decoded image data", async () => {
  const f = fixture();f.material.setBaseColorFactor([.5,1,1,1]);
  f.primitive.setAttribute("COLOR_0",f.doc.createAccessor().setType("VEC4").setBuffer(f.buffer).setArray(new Float32Array([.5,1,1,1,.5,1,1,1,.5,1,1,1])));
  const decode = vi.fn(async () => f.pixels);const samplers = await createLightmapMaterialSamplers([f.primitive,f.primitive],decode);
  const diffuse = new Vector3();samplers.get(f.primitive)!([0,1,2],[1,0,0],diffuse,new Vector3());
  expect(diffuse.x).toBe(.25);expect(decode).toHaveBeenCalledOnce();
});
it("rejects missing UV and malformed decoded pixels", async () => {
  const f = fixture();f.primitive.setAttribute("TEXCOORD_0",null);
  await expect(sample(f)).rejects.toThrow("纹理坐标");
  await expect(createLightmapMaterialSamplers([fixture().primitive],async()=>({width:2,height:2,data:new Uint8ClampedArray(4)}))).rejects.toThrow("像素无效");
});
it("does not decode base-color textures when only preserving emission without indirect light", async () => {
  const f = fixture(), decode = vi.fn(async()=>f.pixels);
  await createLightmapMaterialSamplers([f.primitive],decode,false);expect(decode).not.toHaveBeenCalled();
});
