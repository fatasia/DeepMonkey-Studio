import {PbrRenderer,type RenderView} from "../src/webgpu/pbrRenderer.js";
import {materializeRuntimeRenderPacket} from "../src/runtimePackage/renderPacket.js";
import type {DeepRuntimePackageV1} from "../src/runtimePackage/types.js";
import type {J3NormalShadowManifest} from "./j3NormalShadowMatrix.js";
import {buildJ3AuthorFogMatrix} from "./j3AuthorFogMatrix.js";
import {sha256Utf8} from "../src/shaderPackage/hash.js";
import {sceneShader} from "../src/webgpu/pbrShader.js";
import {decodeFloat16Bits} from "./temporalAaProbe.js";
interface Mode {id:string;kind:"linear"|"volumetric";near?:number;far?:number;density?:number}
export interface AuthorModesFixture {schema:string;color:readonly [number,number,number];absoluteTolerance:number;profiles:readonly Mode[]}
export function authorModeFactor(mode:Mode,depth:number){
  if(mode.kind==="volumetric")return 1-Math.exp(-mode.density!*depth);
  const t=Math.max(0,Math.min(1,(depth-mode.near!)/(mode.far!-mode.near!)));return t*t*(3-2*t);
}
export function buildWebAuthorModesPlan(source:DeepRuntimePackageV1,manifest:J3NormalShadowManifest,f:AuthorModesFixture){
  const plan=buildJ3AuthorFogMatrix(source,manifest,{schema:f.schema,color:f.color,cpuAbsoluteTolerance:f.absoluteTolerance,crossHostAbsoluteTolerance:f.absoluteTolerance,
    scenarios:f.profiles.map(p=>({id:p.id,density:p.density??0,materialFog:true}))});
  return {...plan,profiles:f.profiles,tolerance:f.absoluteTolerance,cameras:plan.cameras.map(c=>({...c,points:c.points.map(p=>({...p,
    expected:Object.fromEntries(f.profiles.map(mode=>{const factor=authorModeFactor(mode,p.depth);return [mode.id,p.base.map((v,k)=>v*(1-factor)+f.color[k]!*factor)];}))}))}))};
}
type Plan=ReturnType<typeof buildWebAuthorModesPlan>;
interface Frame {cameraId:string;profile:string;round:number;hdr:number[][];rgbaHash:string;vp:number[]}
interface Host {passed:boolean;packageHash:string;packetHash:string;frames:Frame[];sourceHash:string;errors:readonly unknown[]}
export function compareWebAuthorModes(plan:Plan,host:Host){
  if(!host.passed||host.errors.length||host.packageHash!==plan.packageHash||host.packetHash!==plan.packetHash||host.frames.length!==8||host.sourceHash.length!==64)throw Error("Author Fog mode actual identity/matrix failed");
  let maxCpuError=0,pointsCompared=0;
  for(const c of plan.cameras)for(const profile of plan.profiles)for(let round=0;round<2;round++){
    const actual=host.frames.find(f=>f.cameraId===c.id&&f.profile===profile.id&&f.round===round),first=host.frames.find(f=>f.cameraId===c.id&&f.profile===profile.id&&f.round===0);
    if(!actual||actual.hdr.length!==c.points.length||actual.vp.length!==16||actual.vp.some((v,k)=>!Number.isFinite(v)||Math.abs(v-c.expectedVP[k]!)>1e-5)||actual.rgbaHash.length!==64||actual.rgbaHash!==first?.rgbaHash)throw Error("Author Fog mode camera/stability failed");
    for(const [i,p] of c.points.entries()){
      const hdr=actual.hdr[i]!,expected=p.expected[profile.id]!;if(hdr.length!==4||hdr[3]!==1)throw Error("Author Fog mode alpha failed");
      for(let k=0;k<3;k++){const error=Math.abs(hdr[k]!-expected[k]!);if(!Number.isFinite(error)||error>plan.tolerance)throw Error(`Author Fog mode CPU failed ${c.id}/${profile.id}/${p.pixel}`);maxCpuError=Math.max(maxCpuError,error);}
      pointsCompared++;
    }
  }
  return {passed:true,stable:true,pointsCompared,maxCpuError,scope:"Web-only actual author linear and bounded eight-step Fog",excluded:["Native authored linear mode","cross-host same-mode parity","RT","frame performance"]};
}
export async function runWebAuthorFogModes(canvas:HTMLCanvasElement,source:DeepRuntimePackageV1,manifest:J3NormalShadowManifest,f:AuthorModesFixture,observe?:(id:string,round:number)=>Promise<void>){
  const plan=buildWebAuthorModesPlan(source,manifest,f),abort=new AbortController();
  const original=materializeRuntimeRenderPacket(source.payloads[source.entrypoints.renderPacket],"$.fogModesPacket");
  const renderer=await PbrRenderer.create(canvas,navigator.gpu,abort.signal,{deformation:true,shadows:{exactProfile:{cascadeCount:1,shadowMapSize:128}},
    features:{environment:false,groundPlane:false,groundGrid:false,ambientOcclusion:false,temporalAa:false,occlusionCulling:false,bloom:false,vignette:false,fog:false}});
  const device=renderer.session.device,frames:Frame[]=[];
  try{
    await renderer.setPacketValidated({...original,materials:original.materials.map(m=>({...m,shadingModel:"unlit",fog:true}))},abort.signal);
    for(const profile of f.profiles)for(const camera of plan.cameras)for(let round=0;round<2;round++){
      const fog=profile.kind==="linear"?{kind:profile.kind,color:f.color,near:profile.near!,far:profile.far!}:{kind:profile.kind,color:f.color,density:profile.density!};
      const view:RenderView={...camera,width:plan.width,height:plan.height,pixelRatio:1,extent:8,background:[0,0,0],floor:[0,0,0],exposure:1,roughness:.8,environmentIntensity:0,
        lights:{directional:[],points:[],spots:[],areas:[],ambient:[],hemisphere:[]},fog};
      const metrics=await renderer.validateFrame(view);if(metrics.drawCalls<1)throw Error("Author Fog mode production frame is empty");
      const actual=renderer as unknown as {targets:{hdrTexture:GPUTexture};frameData:Float32Array};
      const read=device.createBuffer({size:plan.width*plan.height*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try{
        const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:actual.targets.hdrTexture},{buffer:read,bytesPerRow:plan.width*8,rowsPerImage:plan.height},[plan.width,plan.height]);
        device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const bits=new Uint16Array(read.getMappedRange());
        frames.push({cameraId:camera.id,profile:profile.id,round,hdr:camera.points.map(p=>Array.from(bits.slice(p.pixel*4,p.pixel*4+4),decodeFloat16Bits)),
          rgbaHash:sha256Utf8(Array.from(bits).join(",")),vp:Array.from(actual.frameData.slice(0,16))});
      }finally{if(read.mapState==="mapped")read.unmap();read.destroy();}
      await observe?.(`${camera.id}-${profile.id}`,round);
    }
    return {passed:true,packageHash:plan.packageHash,packetHash:plan.packetHash,frames,sourceHash:sha256Utf8(sceneShader),errors:renderer.session.diagnostics};
  }finally{abort.abort();renderer.dispose();}
}
