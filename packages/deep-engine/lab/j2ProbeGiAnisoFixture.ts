import {buildJ3NormalShadowMatrix,type J3NormalShadowManifest} from "./j3NormalShadowMatrix.js";
import {materializeRuntimeRenderPacket} from "../src/runtimePackage/renderPacket.js";
import type {DeepRuntimePackageV1} from "../src/runtimePackage/types.js";
import type {RuntimePrefilteredIbl} from "../src/runtimePackage/environmentTypes.js";
import {PbrRenderer,type RenderView} from "../src/webgpu/pbrRenderer.js";
import {packProbeLevels} from "../src/lighting/probeClipmapResourceData.js";
import {sampleIrradianceProbeClipmap} from "../src/lighting/probeClipmapSampling.js";
import {sha256Utf8} from "../src/shaderPackage/hash.js";
import {sceneShader} from "../src/webgpu/pbrShader.js";
import {decodeFloat16Bits} from "./temporalAaProbe.js";

export interface ProbeAnisoFixture {
  schema:string;origin:readonly [number,number,number];spacing:number;gridSize:readonly [number,number,number];normalBiasCells:number;
  dfg:readonly [number,number];dielectric:number;metallic:number;roughness:number;absoluteTolerance:number;
  zRamp:readonly (readonly [number,number,number])[];checkerEven:readonly [number,number,number];checkerOdd:readonly [number,number,number];
}
export const PROBE_ANISO_SCENARIOS=["zero","z-ramp","checker"] as const;
export type ProbeAnisoScenario=typeof PROBE_ANISO_SCENARIOS[number];
export const ANISO_SCHEMA="j2-b5-aniso-probe-v1";
/** Handover cross-check values recomputed independently by CPU admission (see aniso spec). */
export const HANDOVER_ADMISSION={native:0.12419672,web:0.23968663} as const;
export const probeAnisoShaderHash=sha256Utf8(sceneShader);

export function probeAnisoGain(host:"native"|"web",f:ProbeAnisoFixture){
  if(host==="native")return 1/Math.PI;
  const sum=f.dfg[0]+f.dfg[1],fraction=(f.dielectric*f.dfg[0]+f.dfg[1])*(1+f.dielectric*(1/Math.max(sum,.05)-1));
  return 1-fraction;
}
export function anisoCellIrradiance(cell:readonly [number,number,number],scenario:ProbeAnisoScenario,f:ProbeAnisoFixture){
  if(scenario==="zero")return [0,0,0] as const;
  if(scenario==="z-ramp")return f.zRamp[cell[2]!]!;
  return (cell[0]!+cell[1]!+cell[2]!)%2===0?f.checkerEven:f.checkerOdd;
}
/** Geometry-only admission, same math as B5 probeActualWeight, independently restated. */
export function probeAnisoWeight(world:readonly number[],normal:readonly number[],grid:{origin:readonly number[];spacing:number},family:"native"|"web"){
  const length=Math.hypot(...normal),n=normal.map(v=>v/length),coordinate=world.map((v,k)=>(v+(family==="web"?n[k]!*grid.spacing*.2:0)-grid.origin[k]!)/grid.spacing);
  const low=coordinate.map(v=>Math.min(Math.floor(v),1)),fraction=coordinate.map((v,k)=>Math.max(0,Math.min(1,v-low[k]!)));
  let total=0;
  for(let corner=0;corner<8;corner++){
    const bits=[corner&1,(corner>>1)&1,(corner>>2)&1],cell=low.map((v,k)=>v+bits[k]!);
    const trilinear=bits.reduce((weight,bit,k)=>weight*(bit?fraction[k]!:1-fraction[k]!),1);
    const toProbe=cell.map((v,k)=>grid.origin[k]!+v*grid.spacing-world[k]!),distance=Math.hypot(...toProbe);
    const cosine=distance>1e-6?toProbe.reduce((dot,v,k)=>dot+v*n[k]!,0)/distance:1;
    total+=trilinear*Math.max(cosine,0)**3;
  }return total;
}
export function anisoLevel(f:ProbeAnisoFixture){
  return {level:0,gridSize:f.gridSize,originCell:[-1,-1,-1] as const,origin:f.origin,spacing:f.spacing,probeCount:27,max:f.origin.map(v=>v+2*f.spacing) as [number,number,number]};
}
function anisoRecords(scenario:ProbeAnisoScenario,f:ProbeAnisoFixture){
  return Array.from({length:27},(_,linear)=>{
    const cell=[linear%3,Math.floor(linear/3)%3,Math.floor(linear/9)] as [number,number,number];
    return {irradiance:anisoCellIrradiance(cell,scenario,f),validity:1,meanDistance:100000,distanceVariance:1};
  });
}
/** Formal CPU storage reference (canonical sampler) for the Native oracle. */
export function anisoStorageSample(world:readonly number[],normal:readonly number[],scenario:ProbeAnisoScenario,f:ProbeAnisoFixture){
  return sampleIrradianceProbeClipmap({levels:[anisoLevel(f)],records:anisoRecords(scenario,f),
    worldPosition:world as [number,number,number],worldNormal:normal as [number,number,number]});
}
function anisoNormalWeight(probePosition:readonly number[],shadingPoint:readonly number[],normal:readonly number[]){
  const toProbe=probePosition.map((v,k)=>v-shadingPoint[k]!),length=Math.hypot(...toProbe);
  if(!(length>1e-6))return 1;
  const cosine=toProbe.reduce((dot,v,k)=>dot+v*normal[k]!,0)/length;
  return cosine>0?cosine**3:0;
}
/** Independent CPU mirror of the biased-texture semantics (normal-bias receiver coordinates,
 * 8 textureLoad taps, trilinear*validity*normalWeight, any positive weight is valid, no
 * Chebyshev statistics - the texture path carries none and none are invented here). */
export function anisoTextureSample(world:readonly number[],normalInput:readonly number[],scenario:ProbeAnisoScenario,f:ProbeAnisoFixture){
  const normalLength=Math.hypot(...normalInput),normal=normalLength>1e-6?normalInput.map(v=>v/normalLength):[0,1,0];
  const receiver=world.map((v,k)=>v+normal[k]!*f.spacing*.2),upper=f.gridSize.map(v=>v-1);
  const coordinate=receiver.map((v,k)=>Math.min(Math.max((v-f.origin[k]!)/f.spacing,0),upper[k]!));
  const low=coordinate.map((v,k)=>Math.min(Math.floor(v),f.gridSize[k]!-2)),fraction=coordinate.map((v,k)=>Math.max(0,Math.min(1,v-low[k]!)));
  const sum=[0,0,0];let total=0;
  for(let corner=0;corner<8;corner++){
    const bits=[corner&1,(corner>>1)&1,(corner>>2)&1],cell=low.map((v,k)=>v+bits[k]!);
    const trilinear=bits.reduce((weight,bit,k)=>weight*(bit?fraction[k]!:1-fraction[k]!),1);
    if(!(trilinear>0))continue;
    const rgb=anisoCellIrradiance(cell as [number,number,number],scenario,f);
    const probePosition=cell.map((v,k)=>f.origin[k]!+v*f.spacing),weight=trilinear*anisoNormalWeight(probePosition,world,normal);
    for(let k=0;k<3;k++)sum[k]!+=Math.max(0,rgb[k]!)*weight;
    total+=weight;
  }
  if(!(total>0))return {irradiance:[0,0,0] as const,alpha:0};
  return {irradiance:sum.map(v=>v/total) as [number,number,number],alpha:1};
}
export interface ProbeAnisoPoint {pixel:number;base:number[];world:number[];normal:number[]}
export function expectedProbeAnisoHdr(point:{pixel?:number;world:readonly number[];normal:readonly number[];base:readonly number[]},scenario:ProbeAnisoScenario,f:ProbeAnisoFixture,family:"native"|"web"){
  const gain=probeAnisoGain(family,f);
  if(family==="native"){
    const sample=anisoStorageSample(point.world,point.normal,scenario,f);
    if(sample.fallback||sample.accumulatedWeight<.001)throw Error(`Aniso storage oracle rejected ${scenario} at pixel ${point.pixel??"?"}`);
    return point.base.map((b,k)=>b*sample.irradiance[k]!*gain);
  }
  const sample=anisoTextureSample(point.world,point.normal,scenario,f);
  if(sample.alpha!==1)throw Error(`Aniso texture oracle rejected ${scenario} at pixel ${point.pixel??"?"}`);
  return point.base.map((b,k)=>b*sample.irradiance[k]!*gain);
}
/** Demonstrability proof: the candidate origin must legally expose different z cells per family
 * (storage admitted z layer vs biased-texture two-layer mix), while a uniform input provably
 * collapses back to that value on both families (normalization cancels coordinates again). */
export function assertAnisoZCellVisibility(points:readonly {world:readonly number[];normal:readonly number[]}[],f:ProbeAnisoFixture){
  const unit=(p:{normal:readonly number[]})=>{const l=Math.hypot(...p.normal);return p.normal[2]!/l;};
  for(const p of points){
    const nativeLow=Math.min(Math.floor((p.world[2]!-f.origin[2]!)/f.spacing),f.gridSize[2]!-2);
    const receiverZ=p.world[2]!+unit(p)*f.spacing*.2;
    const webLow=Math.min(Math.floor((receiverZ-f.origin[2]!)/f.spacing),f.gridSize[2]!-2);
    if(nativeLow===webLow)throw Error("Aniso candidate origin no longer separates storage and biased-texture z cells");
  }
  const layer1=f.zRamp[1]!;
  for(const p of points){
    const nativeRamp=anisoStorageSample(p.world,p.normal,"z-ramp",f),webRamp=anisoTextureSample(p.world,p.normal,"z-ramp",f);
    if(nativeRamp.fallback||nativeRamp.accumulatedWeight<.001||webRamp.alpha!==1)throw Error("Aniso z-cell proof lost admission");
    for(let k=0;k<3;k++){
      if(Math.abs(nativeRamp.irradiance[k]!-layer1[k]!)>1e-9)throw Error("Storage z-ramp sampling no longer reduces to the single legally admitted z layer");
      if(!(Math.abs(webRamp.irradiance[k]!-layer1[k]!)>f.absoluteTolerance)||!(webRamp.irradiance[k]!>layer1[k]!))throw Error("Biased texture no longer exposes a different z cell under the z ramp");
    }
  }
  const uniform=points[0]!,uniformFixture:ProbeAnisoFixture={...f,zRamp:[layer1,layer1,layer1]};
  const uniformSamples=["native","web"] as const;
  for(const family of uniformSamples){
    const irradiance=(family==="native"?anisoStorageSample(uniform.world,uniform.normal,"z-ramp",uniformFixture).irradiance:anisoTextureSample(uniform.world,uniform.normal,"z-ramp",uniformFixture).irradiance);
    for(let k=0;k<3;k++)if(Math.abs(irradiance[k]!-layer1[k]!)>1e-9)throw Error(`Uniform collapse control failed on ${family}`);
  }
  for(const p of points){
    const native=anisoStorageSample(p.world,p.normal,"checker",f).irradiance,web=anisoTextureSample(p.world,p.normal,"checker",f).irradiance;
    for(let k=0;k<3;k++)if(!(Math.abs(native[k]!-web[k]!)>f.absoluteTolerance))throw Error("Checker scenario no longer separates the two family z-cell sets");
  }
}
export function buildProbeAnisoPlan(source:DeepRuntimePackageV1,m:J3NormalShadowManifest,f:ProbeAnisoFixture){
  if(f.schema!==ANISO_SCHEMA||f.origin[0]!==-16||f.origin[1]!==-16||f.origin[2]!==-15||f.normalBiasCells!==.2||f.metallic!==0||f.roughness!==.8||f.absoluteTolerance!==.001||f.gridSize.some(v=>v!==3)
    ||f.zRamp.length!==3||!f.zRamp.every(l=>l.length===3&&l.every(Number.isFinite))||!f.checkerEven.every(Number.isFinite)||!f.checkerOdd.every(Number.isFinite))throw Error("Probe aniso frozen profile changed");
  const matrix=buildJ3NormalShadowMatrix(source,m),packet=materializeRuntimeRenderPacket(source.payloads[source.entrypoints.renderPacket],"$.probeAniso");
  const cameras=m.cameras.map(camera=>({...camera,points:matrix.cases.filter(c=>c.cameraId===camera.id&&c.cascadeCount===1).flatMap(c=>{
    const instance=packet.instances.find(i=>i.id===c.instanceId)!,material=packet.materials.find(v=>v.id===instance.material)!;
    return c.points.map(p=>{if(p.worldPoint.some((v,k)=>v<f.origin[k]!+f.spacing*.2||v>f.origin[k]!+f.spacing*1.8))throw Error("Probe aniso common point outside interior");
      return {pixel:p.pixel,base:Array.from(material.baseColor).slice(0,3),world:p.worldPoint,normal:p.expectedWorldNormal};});
  })}));
  if(cameras.reduce((n,c)=>n+c.points.length,0)!==85)throw Error("Probe aniso original85 masks changed");
  const points=cameras.flatMap(c=>c.points);
  let minNative=Infinity,minWeb=Infinity;
  for(const p of points){
    const native=probeAnisoWeight(p.world,p.normal,f,"native"),web=probeAnisoWeight(p.world,p.normal,f,"web");
    if(!(native>=.001&&web>0))throw Error(`Aniso geometry admission failed at pixel ${p.pixel}`);
    minNative=Math.min(minNative,native);minWeb=Math.min(minWeb,web);
  }
  if(Math.abs(minNative-HANDOVER_ADMISSION.native)>1e-8||Math.abs(minWeb-HANDOVER_ADMISSION.web)>1e-8)
    throw Error(`Aniso handover admission mismatch: cpu ${minNative}/${minWeb} vs handover ${HANDOVER_ADMISSION.native}/${HANDOVER_ADMISSION.web}`);
  for(const scenario of ["z-ramp","checker"] as const)for(const p of points){
    const sample=anisoStorageSample(p.world,p.normal,scenario,f);
    if(sample.fallback||sample.accumulatedWeight<.001)throw Error(`Aniso storage admission rejected ${scenario} at pixel ${p.pixel}`);
  }
  assertAnisoZCellVisibility(points,f);
  return {packageHash:m.packageHash,packetHash:m.packetHash,width:m.width,height:m.height,cameras,fixture:f,
    admission:{minNative,minWeb,handover:HANDOVER_ADMISSION}};
}
interface ProbeAnisoFrame {cameraId:string;scenario:string;round:number;samples:{pixel:number;hdr:number[]}[];rgbaHash:string;vp:number[];frame?:number[];frameHash?:string}
export interface ProbeAnisoHost {passed:boolean;packageHash:string;packetHash:string;sourceHash:string;frames:ProbeAnisoFrame[];errors:readonly unknown[]}
export function compareProbeAniso(plan:ReturnType<typeof buildProbeAnisoPlan>,host:ProbeAnisoHost,family:"native"|"web"){
  if(!host.passed||host.errors.length||host.packageHash!==plan.packageHash||host.packetHash!==plan.packetHash||host.frames.length!==12||!/^[a-f0-9]{64}$/.test(host.sourceHash))throw Error("Probe aniso host identity/matrix failed");
  let pointsCompared=0,maxCpuError=0,positivePoints=0;
  for(const c of plan.cameras)for(const scenario of PROBE_ANISO_SCENARIOS)for(let round=0;round<2;round++){
    const frame=host.frames.find(v=>v.cameraId===c.id&&v.scenario===scenario&&v.round===round),first=host.frames.find(v=>v.cameraId===c.id&&v.scenario===scenario&&v.round===0);
    if(!frame||frame.samples.length!==c.points.length||frame.rgbaHash!==first?.rgbaHash||frame.rgbaHash.length!==64||frame.vp.length!==16||frame.vp.some((v,k)=>!Number.isFinite(v)||Math.abs(v-c.expectedVP[k]!)>1e-5))throw Error("Probe aniso camera/hash failed");
    for(const [i,p] of c.points.entries()){
      const a=frame.samples[i]!;if(a.pixel!==p.pixel||a.hdr.length!==4||a.hdr[3]!==1)throw Error("Probe aniso mask/alpha failed");
      const expected=expectedProbeAnisoHdr(p,scenario,plan.fixture,family);
      for(let k=0;k<3;k++){
        const error=Math.abs(a.hdr[k]!-expected[k]!);
        if(!Number.isFinite(error)||error>plan.fixture.absoluteTolerance)throw Error(`Aniso ${family} CPU failed ${c.id}/${scenario}/${p.pixel}/${k}: ${a.hdr[k]} vs ${expected[k]}`);
        maxCpuError=Math.max(maxCpuError,error);
        if(scenario!=="zero"&&p.base[k]!>0){if(!(a.hdr[k]!>0))throw Error("Probe aniso GI positive contribution absent");positivePoints++;}
      }pointsCompared++;
    }
  }
  return {passed:true,family,pointsCompared,positivePoints,maxCpuError,
    scope:"anisotropic independent host oracles: storage vs biased texture z cells; original85points, two cameras, two draws; no bare-HDR parity claimed"};
}
export function anisoProbePacket(source:DeepRuntimePackageV1,f:ProbeAnisoFixture){
  const json=structuredClone(source.payloads[source.entrypoints.renderPacket]) as {materials:Record<string,unknown>[]};
  json.materials=json.materials.map(m=>{const {shadingModel:_shadingModel,...pbr}=m;return {...pbr,metallic:f.metallic,roughness:f.roughness,ior:1.5,fog:false,emissiveFactor:[0,0,0]};});
  return json;
}
export function blackProbeAnisoIbl(f:ProbeAnisoFixture):RuntimePrefilteredIbl {
  const encode=(bits:readonly number[])=>{const data=new Uint16Array(bits);return btoa(String.fromCharCode(...new Uint8Array(data.buffer)));};
  const black=encode(Array.from({length:6},()=>[0,0,0,0x3c00]).flat());
  return {schema:"deep-engine.ibl-prefiltered",schemaVersion:1,id:"j2-probe-aniso-ibl",revision:1,kind:"prefiltered-hdri",format:"rgba16float",encoding:"base64-le",faceOrder:"px-nx-py-ny-pz-nz",
    source:{contentHash:{algorithm:"sha256",value:sha256Utf8(JSON.stringify(f))},license:"CC0 authored diagnostic data"},specular:{mips:[{size:1,dataBase64:black}]},diffuse:{mips:[{size:1,dataBase64:black}]},brdfLut:{width:1,height:1,dataBase64:encode([0x3a00,0x2c00,0,0x3c00])}};
}
const ANISO_HALF_BITS:Record<number,number>={0:0,0.25:0x3400,0.5:0x3800,1:0x3c00,2:0x4000,4:0x4200};
function anisoHalfBits(value:number){const bits=ANISO_HALF_BITS[value];if(bits===undefined)throw Error(`Aniso frozen input ${value} is not a frozen binary16 value`);return bits;}
export function anisoTextureHalfLanes(scenario:ProbeAnisoScenario,f:ProbeAnisoFixture){
  return Array.from({length:27},(_,linear)=>{
    const cell=[linear%3,Math.floor(linear/3)%3,Math.floor(linear/9)] as [number,number,number],rgb=anisoCellIrradiance(cell,scenario,f);
    return [anisoHalfBits(rgb[0]!),anisoHalfBits(rgb[1]!),anisoHalfBits(rgb[2]!),0x3c00];
  }).flat();
}
export async function runProbeAniso(canvas:HTMLCanvasElement,source:DeepRuntimePackageV1,m:J3NormalShadowManifest,f:ProbeAnisoFixture,observe?:(id:string,round:number)=>Promise<void>){
  const plan=buildProbeAnisoPlan(source,m,f),abort=new AbortController();
  const renderer=await PbrRenderer.create(canvas,navigator.gpu,abort.signal,{deformation:true,environment:{kind:"prefiltered-ibl",environment:blackProbeAnisoIbl(f)},shadows:{exactProfile:{cascadeCount:1,shadowMapSize:64}},
    features:{environment:true,textureArrays:false,layeredMaterials:false,groundPlane:false,groundGrid:false,ambientOcclusion:false,temporalAa:false,occlusionCulling:false,bloom:false,vignette:false,fog:false}});
  const device=renderer.session.device,frames:ProbeAnisoFrame[]=[],owned:(GPUTexture|GPUBuffer)[]=[];
  const probeInputs:{id:string;textureHalfBits:number[];metadataBytes:number[];textureHash:string;metadataHash:string}[]=[];
  try{
    const actualPacket=anisoProbePacket(source,f),packet=materializeRuntimeRenderPacket(actualPacket,"$.probeAniso");
    await renderer.setPacketValidated(packet,abort.signal);
    const texture=device.createTexture({size:[3,3,3],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});owned.push(texture);
    const metadata=device.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});owned.push(metadata);
    const max=f.origin.map(v=>v+2*f.spacing) as [number,number,number];
    const metadataBytes=new Uint8Array(256);metadataBytes.set(new Uint8Array(packProbeLevels([{level:0,gridSize:[3,3,3],originCell:[-1,-1,-1],origin:f.origin,max,spacing:f.spacing,probeCount:27}])));
    device.queue.writeBuffer(metadata,0,metadataBytes);
    const sampler=device.createSampler({minFilter:"linear",magFilter:"linear"});
    renderer.setProbeClipmap({view:texture.createView({dimension:"2d-array"}),sampler,levelMetadataBuffer:metadata});
    for(const scenario of PROBE_ANISO_SCENARIOS){
      const texels=new Uint16Array(anisoTextureHalfLanes(scenario,f));
      device.queue.writeTexture({texture},texels,{bytesPerRow:24,rowsPerImage:3},[3,3,3]);
      probeInputs.push({id:scenario,textureHalfBits:Array.from(texels),metadataBytes:Array.from(metadataBytes),textureHash:sha256Utf8(Array.from(texels).join(",")),metadataHash:sha256Utf8(Array.from(metadataBytes).join(","))});
      for(const camera of plan.cameras)for(let round=0;round<2;round++){
        const view:RenderView={...camera,width:plan.width,height:plan.height,pixelRatio:1,extent:8,background:[0,0,0],floor:[0,0,0],exposure:1,roughness:f.roughness,environmentIntensity:1,
          lights:{directional:[],points:[],spots:[],areas:[],ambient:[],hemisphere:[]},fog:{kind:"exp2",density:0,color:[0,0,0]}};
        const metric=await renderer.validateFrame(view);if(metric.drawCalls<1)throw Error("Probe aniso empty frame");
        const actual=renderer as unknown as {targets:{hdrTexture:GPUTexture};frameData:Float32Array};
        const read=device.createBuffer({size:plan.width*plan.height*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        try{const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture:actual.targets.hdrTexture},{buffer:read,bytesPerRow:plan.width*8,rowsPerImage:plan.height},[plan.width,plan.height]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
          const bits=new Uint16Array(read.getMappedRange()),frame=Array.from(actual.frameData);frames.push({cameraId:camera.id,scenario,round,samples:camera.points.map(p=>({pixel:p.pixel,hdr:Array.from(bits.slice(p.pixel*4,p.pixel*4+4),decodeFloat16Bits)})),rgbaHash:sha256Utf8(Array.from(bits).join(",")),vp:frame.slice(0,16),frame,frameHash:sha256Utf8(JSON.stringify(frame))});
        }finally{if(read.mapState==="mapped")read.unmap();read.destroy();}
        await observe?.(`${camera.id}-${scenario}`,round);
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
