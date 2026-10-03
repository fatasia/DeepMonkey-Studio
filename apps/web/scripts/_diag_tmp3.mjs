import fs from "node:fs"; import sharp from "sharp";
const b = fs.readFileSync("../../test-output/anim-probe/844e151e-8465-4675-9c70-0f8eae0da061.glb");
const jl=b.readUInt32LE(12); const j=JSON.parse(b.slice(20,20+jl).toString()); const bin=b.slice(20+jl+8);
for (const [i,img] of (j.images||[]).entries()) { const v=j.bufferViews[img.bufferView]; const d=bin.slice(v.byteOffset||0,(v.byteOffset||0)+v.byteLength); const m=await sharp(d).metadata(); console.log(i,img.mimeType,m.width,m.height,v.byteLength); }
console.log(JSON.stringify(j.textures), JSON.stringify(j.materials.map(m=>({n:m.name,pbr:m.pbrMetallicRoughness&&Object.keys(m.pbrMetallicRoughness),ext:m.extensions&&Object.keys(m.extensions),nt:!!m.normalTexture,et:!!m.emissiveTexture}))));
