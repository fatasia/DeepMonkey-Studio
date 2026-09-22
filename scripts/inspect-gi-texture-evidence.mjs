import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../apps/web/package.json',import.meta.url)),sharp=require('sharp');
const [sourceArg='test-output/lightmap-gi-20260918/round-1-gi-on.glb',runtimeArg='test-output/native-baked-gi-20260918-r2/on.runtime.json',outputArg='test-output/gi-texture-inspection-20260918']=process.argv.slice(2);
const source=await readFile(sourceArg);
const length=source.readUInt32LE(12),json=JSON.parse(source.subarray(20,20+length).toString()),bin=source.subarray(28+length);
const output=path.resolve(outputArg);await mkdir(output,{recursive:true});
const images=[];
for(const [index,image] of json.images.entries()){
  const view=json.bufferViews[image.bufferView],bytes=bin.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength);
  const decoded=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  await sharp(bytes).png().toFile(path.join(output,`image-${index}.png`));
  images.push({index,width:decoded.info.width,height:decoded.info.height,rgbaSha256:createHash('sha256').update(decoded.data).digest('hex')});
}
const runtime=JSON.parse(await readFile(runtimeArg,'utf8'));
const packet=runtime.payloads[runtime.entrypoints.renderPacket];
const uvChecks=[];
for(const mesh of json.meshes)for(const primitive of mesh.primitives){
  const accessor=json.accessors[primitive.attributes.TEXCOORD_1],view=json.bufferViews[accessor.bufferView];
  assert.equal(accessor.componentType,5126);assert.equal(accessor.type,'VEC2');const values=[];
  for(let i=0;i<accessor.count;i++)for(let channel=0;channel<2;channel++)values.push(bin.readFloatLE((view.byteOffset??0)+(accessor.byteOffset??0)+i*(view.byteStride??8)+channel*4));
  const match=packet.geometries.find(geometry=>JSON.stringify(geometry.uv1)===JSON.stringify(values));
  assert.ok(match,'Native UV1 must exactly preserve GLB accessor floats');uvChecks.push({geometry:match.id,vertices:accessor.count,exact:true});
}
const nativeHashes=packet.textures.map(texture=>({semantic:texture.semantic,rgbaSha256:createHash('sha256').update(Buffer.from(texture.data,typeof texture.data==='string'?'base64':undefined)).digest('hex')}));
for(const texture of nativeHashes){const sourceIndex=json.textures[texture.semantic==='emissive'?json.materials[0].emissiveTexture.index:json.materials[0].occlusionTexture.index].source;assert.equal(texture.rgbaSha256,images[sourceIndex].rgbaSha256);}
await writeFile(path.join(output,'evidence.json'),JSON.stringify({sourceSha256:createHash('sha256').update(source).digest('hex'),images,nativeHashes,uvChecks,sourceMaterials:json.materials,sourceSamplers:json.samplers,sourceTextures:json.textures,nativeTextures:packet.textures.map(({data,...texture})=>texture),nativeMaterials:packet.materials},null,2));
console.log(JSON.stringify({output,images,textureKeys:Object.keys(packet.textures[0])}));
