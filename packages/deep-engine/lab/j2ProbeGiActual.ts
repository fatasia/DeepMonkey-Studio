import {buildJ3NormalShadowMatrix,type J3NormalShadowManifest} from "./j3NormalShadowMatrix.js";
import {materializeRuntimeRenderPacket} from "../src/runtimePackage/renderPacket.js";
import type {DeepRuntimePackageV1} from "../src/runtimePackage/types.js";
import type {RuntimePrefilteredIbl} from "../src/runtimePackage/environmentTypes.js";
import {PbrRenderer,type RenderView} from "../src/webgpu/pbrRenderer.js";
import {packProbeLevels} from "../src/lighting/probeClipmapResourceData.js";
import {sha256Utf8} from "../src/shaderPackage/hash.js";
import {sceneShader} from "../src/webgpu/pbrShader.js";
import {sampleIrradianceProbeClipmap} from "../src/lighting/probeClipmapSampling.js";
import {decodeFloat16Bits} from "./temporalAaProbe.js";
export interface ProbeActualFixture {
  schema:string;origin:readonly [number,number,number];spacing:number;gridSize:readonly [number,number,number];normalBiasCells:number;
  dfg:readonly [number,number];dielectric:number;metallic:number;roughness:number;absoluteTolerance:number;
  scenarios:readonly {id:string;irradiance:readonly [number,number,number]}[];
}
export function probeGiGain(host:"native"|"web",f:ProbeActualFixture){
  if(host==="native")return 1/Math.PI;
  const sum=f.dfg[0]+f.dfg[1],fraction=(f.dielectric*f.dfg[0]+f.dfg[1])*(1+f.dielectric*(1/Math.max(sum,.05)-1));
  return 1-fraction;
}
export const probeActualShaderHash=sha256Utf8(sceneShader);
/** Geometry-only admission, independent of production sampler and irradiance accumulation. */
export function probeActualWeight(world:readonly number[],normal:readonly number[],f:ProbeActualFixture,family:"native"|"web"){
  const length=Math.hypot(...normal),n=normal.map(v=>v/length),coordinate=world.map((v,k)=>(v+(family==="web"?n[k]!*f.spacing*.2:0)-f.origin[k]!)/f.spacing);
  const low=coordinate.map(v=>Math.min(Math.floor(v),1)),fraction=coordinate.map((v,k)=>Math.max(0,Math.min(1,v-low[k]!)));
  let total=0;
  for(let corner=0;corner<8;corner++){
    const bits=[corner&1,(corner>>1)&1,(corner>>2)&1],cell=low.map((v,k)=>v+bits[k]!);
    const trilinear=bits.reduce((weight,bit,k)=>weight*(bit?fraction[k]!:1-fraction[k]!),1);
    const toProbe=cell.map((v,k)=>f.origin[k]!+v*f.spacing-world[k]!),distance=Math.hypot(...toProbe);
    const cosine=distance>1e-6?toProbe.reduce((dot,v,k)=>dot+v*n[k]!,0)/distance:1;
    total+=trilinear*Math.max(cosine,0)**3;
  }return total;
}
export function buildProbeActualPlan(source:DeepRuntimePackageV1,m:J3NormalShadowManifest,f:ProbeActualFixture){
  if(f.normalBiasCells!==.2||f.metallic!==0||f.gridSize.some(v=>v!==3)||f.scenarios.length!==3||f.scenarios[0]?.id!=="zero")throw Error("Probe actual frozen profile changed");
  const matrix=buildJ3NormalShadowMatrix(source,m),packet=materializeRuntimeRenderPacket(source.payloads[source.entrypoints.renderPacket],"$.probeActual");
  const cameras=m.cameras.map(camera=>({...camera,points:matrix.cases.filter(c=>c.cameraId===camera.id&&c.cascadeCount===1).flatMap(c=>{
    const instance=packet.instances.find(i=>i.id===c.instanceId)!,material=packet.materials.find(v=>v.id===instance.material)!;
    return c.points.map(p=>{if(p.worldPoint.some((v,k)=>v<f.origin[k]!+f.spacing*.2||v>f.origin[k]!+f.spacing*1.8))throw Error("Probe common point outside interior");
      return {pixel:p.pixel,base:Array.from(material.baseColor).slice(0,3),world:p.worldPoint,normal:p.expectedWorldNormal};});
  })}));
  if(cameras.reduce((n,c)=>n+c.points.length,0)!==85)throw Error("Probe original85 masks changed");
  const level={level:0,gridSize:f.gridSize,originCell:[-1,-1,-1] as const,origin:f.origin,spacing:f.spacing,probeCount:27,max:f.origin.map(v=>v+2*f.spacing) as [number,number,number]};
  const records=Array.from({length:27},()=>({irradiance:[.25,.5,1] as const,validity:1,meanDistance:100000,distanceVariance:1}));
  const admissions=cameras.flatMap(c=>c.points.map(p=>({cameraId:c.id,pixel:p.pixel,...sampleIrradianceProbeClipmap({levels:[level],records,worldPosition:p.world,worldNormal:p.normal})})));
  const rejected=admissions.filter(p=>p.fallback||p.accumulatedWeight<.001);
  if(rejected.length)throw Error(`Uniform GI common fixture rejected ${rejected.length}/85 original points by existing storage normal-weight admission; first=${rejected[0]!.cameraId}/${rejected[0]!.pixel}`);
  for(const p of cameras.flatMap(c=>c.points)){
    const native=probeActualWeight(p.world,p.normal,f,"native"),web=probeActualWeight(p.world,p.normal,f,"web");
    if(!(native>=.001&&web>0))throw Error("Independent uniform geometry admission failed in one production family");
  }
  return {packageHash:m.packageHash,packetHash:m.packetHash,width:m.width,height:m.height,cameras,fixture:f};
}
interface ProbeFrame {cameraId:string;scenario:string;round:number;samples:{pixel:number;hdr:number[]}[];rgbaHash:string;vp:number[];frame?:number[];frameHash?:string}
export interface ProbeActualHost {passed:boolean;packageHash:string;packetHash:string;sourceHash:string;frames:ProbeFrame[];errors:readonly unknown[]}
export function probeActualPacket(source:DeepRuntimePackageV1,f:ProbeActualFixture){
  const json=structuredClone(source.payloads[source.entrypoints.renderPacket]) as {materials:Record<string,unknown>[]};
  json.materials=json.materials.map(m=>{const {shadingModel:_shadingModel,...pbr}=m;return {...pbr,metallic:f.metallic,roughness:f.roughness,ior:1.5,fog:false,emissiveFactor:[0,0,0]};});
  return json;
}
export function compareProbeActual(plan:ReturnType<typeof buildProbeActualPlan>,host:ProbeActualHost,family:"native"|"web"){
  if(!host.passed||host.errors.length||host.packageHash!==plan.packageHash||host.packetHash!==plan.packetHash||host.frames.length!==12||!/^[a-f0-9]{64}$/.test(host.sourceHash))throw Error("Probe actual host identity/matrix failed");
  let pointsCompared=0,maxCpuError=0,maxSamplingError=0,positivePoints=0;
  const gain=probeGiGain(family,plan.fixture);
  for(const c of plan.cameras)for(const s of plan.fixture.scenarios)for(let round=0;round<2;round++){
    const frame=host.frames.find(v=>v.cameraId===c.id&&v.scenario===s.id&&v.round===round),first=host.frames.find(v=>v.cameraId===c.id&&v.scenario===s.id&&v.round===0);
    if(!frame||frame.samples.length!==c.points.length||frame.rgbaHash!==first?.rgbaHash||frame.rgbaHash.length!==64||frame.vp.length!==16||frame.vp.some((v,k)=>!Number.isFinite(v)||Math.abs(v-c.expectedVP[k]!)>1e-5))throw Error("Probe actual camera/hash failed");
    for(const [i,p] of c.points.entries()){
      const a=frame.samples[i]!;if(a.pixel!==p.pixel||a.hdr.length!==4||a.hdr[3]!==1)throw Error("Probe actual mask/alpha failed");
      for(let k=0;k<3;k++){
        const expected=p.base[k]!*s.irradiance[k]!*gain,error=Math.abs(a.hdr[k]!-expected);
        if(!Number.isFinite(error)||error>plan.fixture.absoluteTolerance)throw Error(`Probe ${family} CPU failed ${c.id}/${s.id}/${p.pixel}/${k}: ${a.hdr[k]} vs ${expected}`);
        maxCpuError=Math.max(maxCpuError,error);
        if(s.id!=="zero"&&p.base[k]!>0){if(!(a.hdr[k]!>0))throw Error("Probe GI positive contribution absent");positivePoints++;maxSamplingError=Math.max(maxSamplingError,Math.abs(a.hdr[k]!/(p.base[k]!*gain)-s.irradiance[k]!));}
      }pointsCompared++;
    }
  }
  return {passed:true,family,pointsCompared,positivePoints,maxCpuError,maxSamplingError,gain,scope:"uniform actual production GI, distinct host HDR formulas; original85points, two cameras, two draws"};
}
export function blackProbeIbl(f:ProbeActualFixture):RuntimePrefilteredIbl {
  const encode=(bits:readonly number[])=>{const data=new Uint16Array(bits);return btoa(String.fromCharCode(...new Uint8Array(data.buffer)));};
  const black=encode(Array.from({length:6},()=>[0,0,0,0x3c00]).flat());
  return {schema:"deep-engine.ibl-prefiltered",schemaVersion:1,id:"j2-probe-actual-ibl",revision:1,kind:"prefiltered-hdri",format:"rgba16float",encoding:"base64-le",faceOrder:"px-nx-py-ny-pz-nz",
    source:{contentHash:{algorithm:"sha256",value:sha256Utf8(JSON.stringify(f))},license:"CC0 authored diagnostic data"},specular:{mips:[{size:1,dataBase64:black}]},diffuse:{mips:[{size:1,dataBase64:black}]},brdfLut:{width:1,height:1,dataBase64:encode([0x3a00,0x2c00,0,0x3c00])}};
}
export async function runProbeActual(canvas:HTMLCanvasElement,source:DeepRuntimePackageV1,m:J3NormalShadowManifest,f:ProbeActualFixture,observe?:(id:string,round:number)=>Promise<void>){
  const plan=buildProbeActualPlan(source,m,f),abort=new AbortController();
  const renderer=await PbrRenderer.create(canvas,navigator.gpu,abort.signal,{deformation:true,environment:{kind:"prefiltered-ibl",environment:blackProbeIbl(f)},shadows:{exactProfile:{cascadeCount:1,shadowMapSize:64}},
    features:{environment:true,textureArrays:false,layeredMaterials:false,groundPlane:false,groundGrid:false,ambientOcclusion:false,temporalAa:false,occlusionCulling:false,bloom:false,vignette:false,fog:false}});
  const device=renderer.session.device,frames:ProbeFrame[]=[],owned:(GPUTexture|GPUBuffer)[]=[];
  const probeInputs:{id:string;textureHalfBits:number[];metadataBytes:number[];textureHash:string;metadataHash:string}[]=[];
  try{
    const actualPacket=probeActualPacket(source,f),packet=materializeRuntimeRenderPacket(actualPacket,"$.probeActual");
    await renderer.setPacketValidated(packet,abort.signal);
    const texture=device.createTexture({size:[3,3,3],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});owned.push(texture);
    const metadata=device.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});owned.push(metadata);
    const max=f.origin.map(v=>v+2*f.spacing) as [number,number,number];
    const metadataBytes=new Uint8Array(256);metadataBytes.set(new Uint8Array(packProbeLevels([{level:0,gridSize:[3,3,3],originCell:[-1,-1,-1],origin:f.origin,max,spacing:f.spacing,probeCount:27}])));
    device.queue.writeBuffer(metadata,0,metadataBytes);
    const sampler=device.createSampler({minFilter:"linear",magFilter:"linear"});
    renderer.setProbeClipmap({view:texture.createView({dimension:"2d-array"}),sampler,levelMetadataBuffer:metadata});
    for(const s of f.scenarios){
      const half=s.id==="zero"?[0,0,0]:s.id==="uniform-a"?[0x3400,0x3800,0x3c00]:[0x3800,0x3c00,0x4000];
      const texels=new Uint16Array(Array.from({length:27},()=>[...half,0x3c00]).flat());
      device.queue.writeTexture({texture},texels,{bytesPerRow:24,rowsPerImage:3},[3,3,3]);
      probeInputs.push({id:s.id,textureHalfBits:Array.from(texels),metadataBytes:Array.from(metadataBytes),textureHash:sha256Utf8(Array.from(texels).join(",")),metadataHash:sha256Utf8(Array.from(metadataBytes).join(","))});
      for(const camera of plan.cameras)for(let round=0;round<2;round++){
        const view:RenderView={...camera,width:plan.width,height:plan.height,pixelRatio:1,extent:8,background:[0,0,0],floor:[0,0,0],exposure:1,roughness:f.roughness,environmentIntensity:1,
          lights:{directional:[],points:[],spots:[],areas:[],ambient:[],hemisphere:[]},fog:{kind:"exp2",density:0,color:[0,0,0]}};
        const metric=await renderer.validateFrame(view);if(metric.drawCalls<1)throw Error("Probe actual empty frame");
        const actual=renderer as unknown as {targets:{hdrTexture:GPUTexture};frameData:Float32Array};
        const read=device.createBuffer({size:plan.width*plan.height*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        try{const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:actual.targets.hdrTexture},{buffer:read,bytesPerRow:plan.width*8,rowsPerImage:plan.height},[plan.width,plan.height]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
          const bits=new Uint16Array(read.getMappedRange()),frame=Array.from(actual.frameData);frames.push({cameraId:camera.id,scenario:s.id,round,samples:camera.points.map(p=>({pixel:p.pixel,hdr:Array.from(bits.slice(p.pixel*4,p.pixel*4+4),decodeFloat16Bits)})),rgbaHash:sha256Utf8(Array.from(bits).join(",")),vp:frame.slice(0,16),frame,frameHash:sha256Utf8(JSON.stringify(frame))});
        }finally{if(read.mapState==="mapped")read.unmap();read.destroy();}
        await observe?.(`${camera.id}-${s.id}`,round);
      }
    }
    if(packet.deformation||packet.materials.some(v=>v.baseColorTexture||v.normalTexture||v.metallicRoughnessTexture))throw Error("Stock plain module identity requires ordinary undeformed untextured geometry");
    const compileRecords=renderer.getPipelineCompileRecords();
    if(!compileRecords.some(r=>r.label==="Deep forward PBR plain/depth/ccw"&&!r.failed))throw Error("Actual plain HDR module missing in production compile ledger");
    return {passed:true,packageHash:plan.packageHash,packetHash:plan.packetHash,actualPacket,actualPacketJson:JSON.stringify(actualPacket),actualPacketHash:sha256Utf8(JSON.stringify(actualPacket)),
      sourceHash:sha256Utf8(sceneShader),sourceAssembly:{factory:"pipelines.ts moduleCode",deformation:false,textureArrays:false,layeredMaterials:false,vertex:"vertexMain",fragment:"fragmentMain",compileRecords},
      probeInputs,frames,errors:renderer.session.diagnostics};
  }finally{renderer.setProbeClipmap();owned.forEach(v=>v.destroy());abort.abort();renderer.dispose();}
}
