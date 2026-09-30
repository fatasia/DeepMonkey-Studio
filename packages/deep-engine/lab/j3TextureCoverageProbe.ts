import {PbrRenderer,type RenderView} from "../src/webgpu/pbrRenderer.js";
import {materializeRuntimeRenderPacket} from "../src/runtimePackage/renderPacket.js";
import type {RuntimePrefilteredIbl} from "../src/runtimePackage/environmentTypes.js";
import {sha256Utf8} from "../src/shaderPackage/hash.js";
import type {buildTextureCoveragePlan,TextureCoverageFixture} from "./j3TextureCoverageFixture.js";
import {observeTextureCoverageGpu,readTextureCoverageFrame} from "./j3TextureCoverageReadback.js";

type Plan=ReturnType<typeof buildTextureCoveragePlan>;
function constantDfg(f:TextureCoverageFixture):RuntimePrefilteredIbl{
  if(f.dfg[0]!==.75||f.dfg[1]!==.0625)throw Error("Frozen constant DFG changed");
  const encode=(v:number[])=>btoa(String.fromCharCode(...new Uint8Array(new Uint16Array(v).buffer))),black=encode(Array.from({length:6},()=>[0,0,0,0x3c00]).flat());
  return {schema:"deep-engine.ibl-prefiltered",schemaVersion:1,id:"gate-d-texture-ibl",revision:1,kind:"prefiltered-hdri",format:"rgba16float",encoding:"base64-le",faceOrder:"px-nx-py-ny-pz-nz",
    source:{contentHash:{algorithm:"sha256",value:sha256Utf8(JSON.stringify(f))},license:"CC0 authored diagnostic data"},
    specular:{mips:[{size:1,dataBase64:black}]},diffuse:{mips:[{size:1,dataBase64:black}]},brdfLut:{width:1,height:1,dataBase64:encode([0x3a00,0x2c00,0,0x3c00])}};
}
export async function runTextureCoverageProbe(canvas:HTMLCanvasElement,plan:Plan,observe?:(id:string,round:number)=>Promise<void>){
  const f=plan.fixture,abort=new AbortController(),trace=observeTextureCoverageGpu(navigator.gpu);
  let renderer:PbrRenderer|undefined;
  try{
    renderer=await PbrRenderer.create(canvas,trace.gpu,abort.signal,{deformation:true,environment:{kind:"prefiltered-ibl",environment:constantDfg(f)},
      features:{environment:true,textureArrays:false,layeredMaterials:false,groundPlane:false,groundGrid:false,ambientOcclusion:false,temporalAa:false,spatialAa:false,
        occlusionCulling:false,bloom:false,vignette:false,fog:false,screenSpaceReflection:false,volumetricFog:false,contactShadows:false,visibilityBuffer:false}});
    const frames=[];
    for(const scenario of plan.scenarios){
      const packet=materializeRuntimeRenderPacket(scenario.package.payloads[scenario.package.entrypoints.renderPacket],"$.textureActual");
      await renderer.setPacketValidated(packet,abort.signal);
      for(const camera of plan.cameras)for(let round=0;round<2;round++){
        const view:RenderView={...camera,width:plan.width,height:plan.height,pixelRatio:1,extent:8,background:f.background as [number,number,number],floor:[0,0,0],exposure:1,roughness:f.roughness,environmentIntensity:1,fog:null,
          lights:{directional:scenario.id.startsWith("mr-")?[{directionWorld:[0,0,-1],color:f.radiance as [number,number,number],intensity:1,castShadow:false}]:[],points:[],spots:[],areas:[],ambient:[],hemisphere:[]}};
        const metric=await renderer.validateFrame(view);if(metric.drawCalls<1||metric.triangles<1)throw Error("Texture frame empty");
        const actual=await readTextureCoverageFrame(renderer,scenario.id==="blend");
        const coverage=Array.from({length:plan.width*plan.height},(_,pixel)=>Number([0,1,2].some(k=>Math.abs(actual.data[pixel*8+k]!-f.background[k]!)>.008)));
        frames.push({scenario:scenario.id,cameraId:camera.id,round,packageHash:scenario.packageHash,packetHash:scenario.packetHash,
          fullHash:actual.fullHash,normalHash:actual.normalHash,vp:actual.vp,frame:actual.frame,finalAttachment:actual.finalAttachment,drawCalls:metric.drawCalls,triangles:metric.triangles,
          coverage,coveragePixels:coverage.reduce((sum,v)=>sum+v!,0),
          samples:camera.points.map(p=>({pixel:p.pixel,hdr:Array.from(actual.data.slice(p.pixel*8,p.pixel*8+4)),roughness:actual.data[p.pixel*8+7]!}))});
        await observe?.(`${camera.id}-${scenario.id}`,round);
      }
    }
    if(renderer.session.hasErrors)throw Error("Texture production GPU reported errors");
    const compileRecords=renderer.getPipelineCompileRecords();
    if(!compileRecords.some(r=>r.label.includes("material/")&&!r.failed))throw Error("Actual textured material compile ledger absent");
    return {schema:"j3-texture-coverage-host-v1",family:"web",passed:true,sourcePackageHash:plan.sourcePackageHash,sourcePacketHash:plan.sourcePacketHash,...trace.finish(),
      compileRecords,frames,errors:renderer.session.diagnostics};
  }finally{abort.abort();try{renderer?.dispose();}finally{trace.dispose();}}
}
