import {buildJ3NormalShadowMatrix,type J3NormalShadowManifest} from "./j3NormalShadowMatrix.js";
import {materializeRuntimeRenderPacket} from "../src/runtimePackage/renderPacket.js";
import {runtimeContentSha256,runtimePackageSha256} from "../src/runtimePackage/hash.js";
import {serializeDeepRuntimePackage,parseDeepRuntimePackage} from "../src/runtimePackage/serialization.js";
import type {DeepRuntimePackageV1} from "../src/runtimePackage/types.js";
import {buildRenderPacketRayScene} from "../src/rayTracing/renderPacketRayScene.js";
import {traceTlasClosest} from "../src/rayTracing/tlas.js";
import {invertMat4,pixelRayProbe} from "../src/postprocess/temporalMotionReference.js";
import {sceneShader} from "../src/webgpu/pbrShader.js";
import {sha256Utf8} from "../src/shaderPackage/hash.js";
export const textureCoverageExpectedShaderHash=sha256Utf8(sceneShader);

export interface TextureCoverageFixture {
  schema:string;background:number[];uv0:number[];uv1:number[];
  transform:{texCoord:1;offset:[number,number];scale:[number,number];rotation:number};
  baseFactor:number[];emissiveFactor:number[];baseBytes:number[];mrBytes:number[];roughness:number;metallic:number;
  alphaCutoff:number;radiance:number[];surfaceToLight:number[];dfg:number[];scenarios:string[];
  hdrTolerance:number;minimumStablePerCamera:number;minimumStableTotal:number;minimumMetalContributions:number;
}
export function srgbByte(value:number){const c=value/255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;}
function validateFixture(f:TextureCoverageFixture){
  if(f.schema!=="j3-texture-coverage-v1"||f.hdrTolerance!==.002||f.minimumStablePerCamera!==12||f.minimumStableTotal!==32||f.minimumMetalContributions!==16
    ||JSON.stringify(f.scenarios)!==JSON.stringify(["base-uv0","base-uv1","emissive-uv1","mr-linear","mr-zero-metal","mask","blend"]))throw Error("Texture frozen profile changed");
  for(const bytes of [f.baseBytes,f.mrBytes])if(bytes.length!==16||bytes.some(v=>!Number.isInteger(v)||v<0||v>255))throw Error("Invalid authored texels");
  if([...f.uv0,...f.uv1,...f.background,...f.baseFactor,...f.emissiveFactor,...f.transform.offset,...f.transform.scale,f.transform.rotation].some(v=>!Number.isFinite(v))
    ||f.uv0.length!==6||f.uv1.length!==6||f.transform.texCoord!==1)throw Error("Invalid UV fixture");
}
export function textureScenarioPackage(source:DeepRuntimePackageV1,f:TextureCoverageFixture,id:string){
  validateFixture(f);if(!f.scenarios.includes(id))throw Error("Unknown texture scenario");
  const pkg=structuredClone(source) as unknown as Record<string,any>,key=source.entrypoints.renderPacket,p=pkg.payloads[key];
  p.geometries.find((g:any)=>g.id==="golden-triangle").uv0=f.uv0;
  p.geometries.find((g:any)=>g.id==="golden-triangle").uv1=f.uv1;
  const m=p.materials.find((v:any)=>v.id==="golden-copper");
  Object.assign(m,{baseColor:f.baseFactor,metallic:0,roughness:f.roughness,fog:false,emissiveFactor:[0,0,0],shadingModel:"unlit"});
  Object.assign(p.materials.find((v:any)=>v.id==="golden-metal"),{shadingModel:"unlit",baseColor:[.05,.08,.12],emissiveFactor:[0,0,0],fog:false});
  const sampler={magFilter:"nearest",minFilter:"nearest",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge"};
  const base={id:"gate-d-base",revision:1,width:2,height:2,semantic:"baseColor",data:f.baseBytes,sampler};
  const slot={texture:base.id,...(id==="base-uv0"?{texCoord:0}:f.transform)};
  p.textures=[base];m.baseColorTexture=slot;
  if(id==="emissive-uv1"){
    delete m.shadingModel;delete m.baseColorTexture;m.baseColor=[0,0,0];m.emissiveFactor=f.emissiveFactor;
    m.emissiveTexture={...slot,texture:"gate-d-emissive"};p.textures=[{...base,id:"gate-d-emissive",semantic:"emissive"}];
  }
  if(id.startsWith("mr-")){
    delete m.shadingModel;delete m.baseColorTexture;m.metallic=id==="mr-zero-metal"?0:f.metallic;
    m.metallicRoughnessTexture={...slot,texture:"gate-d-mr"};p.textures=[{...base,id:"gate-d-mr",semantic:"metallicRoughness",data:f.mrBytes}];
  }
  if(id==="mask")Object.assign(m,{alphaMode:"MASK",alphaCutoff:f.alphaCutoff});
  if(id==="blend")Object.assign(m,{alphaMode:"BLEND",baseColorAlpha:.75});
  const resource=pkg.resources.find((v:any)=>v.id===key);resource.contentHash={algorithm:"sha256",value:runtimeContentSha256(p)};
  pkg.packageHash={algorithm:"sha256",value:runtimePackageSha256(pkg)};
  const text=serializeDeepRuntimePackage(pkg),result=parseDeepRuntimePackage(text);
  if(!result.valid)throw Error(result.issues[0]?.message);
  return {id,package:result.value,packageText:text,packageHash:result.value.packageHash.value,packetHash:resource.contentHash.value as string};
}
export function buildTextureCoveragePlan(source:DeepRuntimePackageV1,m:J3NormalShadowManifest,f:TextureCoverageFixture){
  validateFixture(f);const original=buildJ3NormalShadowMatrix(source,m),packet=materializeRuntimeRenderPacket(source.payloads[source.entrypoints.renderPacket],"$.textureOriginal");
  const scene=buildRenderPacketRayScene(packet),scenarios=f.scenarios.map(id=>textureScenarioPackage(source,f,id));
  const cameras=m.cameras.map(camera=>{
    const inverse=invertMat4(camera.expectedVP),seen=original.cases.filter(c=>c.cameraId===camera.id&&c.cascadeCount===1).flatMap(c=>c.points.map(p=>({pixel:p.pixel,instanceId:c.instanceId})));
    const at=(pixel:number,dx=0,dy=0)=>{
      const probe=pixelRayProbe(inverse,camera.eye,pixel%m.width+.5+dx,Math.floor(pixel/m.width)+.5+dy,m.width,m.height,1);
      const v=probe.map((x,k)=>x-camera.eye[k]!),length=Math.hypot(...v),d=v.map(x=>x/length);
      const hit=traceTlasClosest(scene.tlas,{ox:camera.eye[0],oy:camera.eye[1],oz:camera.eye[2],dx:d[0]!,dy:d[1]!,dz:d[2]!,tMax:camera.far});
      if(!hit)return null;const i=packet.instances.find(i=>i.id===hit.instanceId)!;
      if(i.geometry!=="golden-triangle")return {instanceId:i.id,uv0:[0,0],uv1:[0,0]};
      const g=packet.geometries.find(g=>g.id===i.geometry)!,world=camera.eye.map((x,k)=>x+d[k]!*hit.t);
      const local=[(world[0]!-i.transform[12]!)/i.transform[0]!, (world[1]!-i.transform[13]!)/i.transform[5]!];
      const t=(local[1]!-g.vertices[1]!)/(g.vertices[13]!-g.vertices[1]!);
      const b=(local[0]!-g.vertices[0]!*(1-t)-g.vertices[12]!*t)/(g.vertices[6]!-g.vertices[0]!);
      const weights=[1-t-b,b,t],uv=(values:number[])=>[0,1].map(k=>weights.reduce((sum,w,j)=>sum+w*values[j*2+k]!,0));
      return {instanceId:i.id,uv0:uv(f.uv0),uv1:uv(f.uv1)};
    };
    const points=seen.map(p=>({...p,byScenario:Object.fromEntries(f.scenarios.map(id=>{
      const hit=at(p.pixel);if(!hit||hit.instanceId!==p.instanceId)throw Error("Original texture85 identity changed");
      const texel=textureTexel(hit,id,f);
      const stable=[-.5,0,.5].every(dy=>[-.5,0,.5].every(dx=>{
        const h=at(p.pixel,dx,dy);return h?.instanceId===p.instanceId&&textureTexel(h,id,f)===texel;
      }));
      const alpha=f.baseBytes[texel*4+3]!/255,expectedCoverage=id!=="mask"||alpha>=f.alphaCutoff;
      const color=id==="emissive-uv1"?f.emissiveFactor.map((v,k)=>v*srgbByte(f.baseBytes[texel*4+k]!))
        :id.startsWith("mr-")?null:f.baseFactor.map((v,k)=>v*srgbByte(f.baseBytes[texel*4+k]!));
      const expected=color?.map((v,k)=>!expectedCoverage?f.background[k]!:id==="blend"?v*alpha*.75+f.background[k]!*(1-alpha*.75):v)??null;
      return [id,{texel,stable,expectedCoverage,expected,roughness:id.startsWith("mr-")?f.roughness*f.mrBytes[texel*4+1]!/255:f.roughness}];
    }))}));
    for(const id of f.scenarios)if(points.filter(p=>(p.byScenario[id] as any).stable).length<f.minimumStablePerCamera)throw Error(`Frozen texture stable mask too small ${camera.id}/${id}`);
    return {...camera,points};
  });
  if(cameras.reduce((n,c)=>n+c.points.length,0)!==85)throw Error("Texture matrix original85 changed");
  for(const id of f.scenarios)if(cameras.reduce((n,c)=>n+c.points.filter(p=>(p.byScenario[id] as any).stable).length,0)<f.minimumStableTotal)throw Error(`Frozen texture stable total too small ${id}`);
  return {schema:"j3-texture-coverage-plan-v1",sourcePackageHash:m.packageHash,sourcePacketHash:m.packetHash,width:m.width,height:m.height,cameras,scenarios,fixture:f};
}
function textureTexel(hit:{uv0:number[];uv1:number[]},id:string,f:TextureCoverageFixture){
  let uv=hit.uv0;
  if(id!=="base-uv0"){
    const [x,y]=hit.uv1.map((v,k)=>v*f.transform.scale[k]!),c=Math.cos(f.transform.rotation),s=Math.sin(f.transform.rotation);
    uv=[c*x!-s*y!+f.transform.offset[0],s*x!+c*y!+f.transform.offset[1]];
  }
  return Math.max(0,Math.min(1,Math.floor(uv[0]!*2)))+2*Math.max(0,Math.min(1,Math.floor(uv[1]!*2)));
}
