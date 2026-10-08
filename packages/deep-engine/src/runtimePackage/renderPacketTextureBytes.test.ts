import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { buildDeepRuntimePackage, parseDeepRuntimePackage, serializeDeepRuntimePackage, validateDeepRuntimePackage } from "./index.js";
import { materializeRuntimeRenderPacket } from "./renderPacket.js";
import { compactRuntimePacketTextures, validateRuntimeTexturePlaneBytes } from "./renderPacketTextureBytes.js";
import { snapshotJson } from "./primitives.js";
import type { RenderPacket } from "../renderPacketTypes.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
it("publishes and rehydrates six actual 2048 RGBA textures without numeric JSON expansion", () => {
  const semantics = ["baseColor", "metallicRoughness", "normal", "emissive", "specular", "specularColor"] as const;
  const textures = semantics.map((semantic, index) => {
    const data = new Uint8Array(2048 * 2048 * 4).fill(index * 37);
    data[0] = 255; data[data.length - 1] = index;
    return { id: semantic, revision: 1, width: 2048, height: 2048, semantic, data };
  });
  const packet: RenderPacket = { textures,
    geometries: [{ id:"g", revision:1, vertices:new Float32Array([-1,-1,0,0,0,1,1,-1,0,0,0,1,0,1,0,0,0,1]),
      indices:new Uint32Array([0,1,2]), uv0:new Float32Array([0,0,1,0,0,1]),
      tangents:new Float32Array([1,0,0,1,1,0,0,1,1,0,0,1]) }],
    materials: [{ id:"m", baseColor:[1,1,1], metallic:0, roughness:.3, alphaMode:"OPAQUE", baseColorAlpha:1,
      baseColorTexture:{texture:"baseColor"}, metallicRoughnessTexture:{texture:"metallicRoughness"},
      normalTexture:{texture:"normal"}, emissiveTexture:{texture:"emissive"},
      specularTexture:{texture:"specular"}, specularColorTexture:{texture:"specularColor"},
      extendedParameters:{transmission:{factor:1}} }],
    instances:[{id:"i",geometry:"g",material:"m",transform:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}] };
  const start = performance.now();
  const result = buildDeepRuntimePackage({ packageId:"texture.large", packageVersion:"0.2.0",
    renderPacket:{id:"scene",revision:1,value:packet} });
  expect(validateDeepRuntimePackage(result).valid).toBe(true);
  const payload = result.payloads.scene as {textures:{data:unknown}[]};
  expect(payload.textures.every(texture => typeof texture.data === "string")).toBe(true);
  const encoded = serializeDeepRuntimePackage(result);
  if (process.env.RUNTIME_LARGE_FIXTURE_PATH) writeFileSync(process.env.RUNTIME_LARGE_FIXTURE_PATH, encoded);
  const parsed = parseDeepRuntimePackage(encoded);
  expect(parsed.valid).toBe(true);
  if (!parsed.valid) throw new Error(parsed.issues[0]?.message);
  const restored = materializeRuntimeRenderPacket(parsed.value.payloads.scene,"$.packet");
  expect(restored.textures!.map(texture=>digest(texture.data))).toEqual(textures.map(texture=>digest(texture.data)));
  expect(restored.materials[0]!.extendedParameters?.transmission?.factor).toBe(1);
  const evidence = {largeTextureBytes:96*1024*1024,textureCount:6,width:2048,height:2048,
    wireBytes:encoded.length,elapsedMs:performance.now()-start,packageHash:result.packageHash.value,
    texturePixelSha256:restored.textures!.map(texture=>digest(texture.data))};
  if (process.env.RUNTIME_LARGE_FIXTURE_PATH) writeFileSync(`${process.env.RUNTIME_LARGE_FIXTURE_PATH}.evidence.json`,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
}, 120_000);

it.each(["AB==", "AQJ=", "AAAA AA==", "AAAAAA=", "AAAAAA===", "AA=A", ""]) (
  "rejects malformed canonical texture base64 %s", data => {
    expect(()=>validateRuntimeTexturePlaneBytes({width:1,height:1,data},"$.plane")).toThrow();
  });
it("retains exact byte dimensions, shared-buffer rejection, ordinary node budget and aggregate budget", () => {
  expect(()=>validateRuntimeTexturePlaneBytes({width:1,height:1,data:"AA=="},"$.plane")).toThrow("dimensions");
  expect(()=>validateRuntimeTexturePlaneBytes({width:16_384,height:16_384,data:"AAAAAA=="},"$.plane")).toThrow("128 MiB");
  expect(()=>snapshotJson({unrelated:new Uint8Array(2_000_001)},true)).toThrow("node budget");
  const data = new Uint8Array(new SharedArrayBuffer(4));
  expect(()=>compactRuntimePacketTextures({textures:[{id:"a",revision:1,width:1,height:1,semantic:"baseColor",data}]})).toThrow("unshared");
  // Nine independent planes exceed the same resident byte limit; reject before encoding them.
  const plane = new Uint8Array(16*1024*1024);
  const textures = Array.from({length:9},(_,index)=>({id:`a${index}`,revision:1,width:2048,height:2048,
    semantic:"baseColor" as const,data:plane}));
  expect(()=>compactRuntimePacketTextures({textures})).toThrow("128 MiB");
});
it("keeps small numeric payloads and unpadded final rows",()=>{
  const data = new Uint8Array([128,64,255,255]);
  const output = compactRuntimePacketTextures({textures:[{id:"a",revision:1,width:1,height:1,semantic:"baseColor" as const,data}]});
  expect(output.textures[0]!.data).toBe(data);
  expect(validateRuntimeTexturePlaneBytes({width:1,height:2,bytesPerRow:8,data:"AAAAAAAAAAAAAAAA"},"$.plane")).toBe(12);
});
it("rejects texture accessors before reading or invoking them",()=>{
  let invoked=0;
  const texture={id:"a",revision:1,width:1,height:1,semantic:"baseColor" as const,get data(){invoked++;return new Uint8Array(4);}};
  expect(()=>compactRuntimePacketTextures({textures:[texture]})).toThrow("Accessors");
  expect(invoked).toBe(0);
});
