import {PbrRenderer,type RenderView} from "../src/webgpu/pbrRenderer.js";
import {materializeRuntimeRenderPacket} from "../src/runtimePackage/renderPacket.js";
import type {DeepRuntimePackageV1} from "../src/runtimePackage/types.js";
import {sha256Utf8} from "../src/shaderPackage/hash.js";
import {sceneShader} from "../src/webgpu/pbrShader.js";
import {decodeFloat16Bits} from "./temporalAaProbe.js";
import {buildJ3AuthorFogMatrix,type J3AuthorFogProfile} from "./j3AuthorFogMatrix.js";
import type {J3NormalShadowManifest} from "./j3NormalShadowMatrix.js";

export async function runJ3AuthorFogProbe(canvas:HTMLCanvasElement,source:DeepRuntimePackageV1,manifest:J3NormalShadowManifest,
  profile:J3AuthorFogProfile,observe?:(id:string,round:number)=>Promise<void>) {
  const plan=buildJ3AuthorFogMatrix(source,manifest,profile),abort=new AbortController();
  const original=materializeRuntimeRenderPacket(source.payloads[source.entrypoints.renderPacket],"$.authorFogPacket");
  const renderer=await PbrRenderer.create(canvas,navigator.gpu,abort.signal,{deformation:true,shadows:{exactProfile:{cascadeCount:1,shadowMapSize:128}},
    features:{environment:false,groundPlane:false,groundGrid:false,ambientOcclusion:false,
      temporalAa:false,occlusionCulling:false,bloom:false,vignette:false,fog:false}});
  const device=renderer.session.device,frames=[];
  try {
    for(const scenario of profile.scenarios) {
      await renderer.setPacketValidated({...original,materials:original.materials.map(m=>({...m,shadingModel:"unlit",fog:scenario.materialFog}))},abort.signal);
      for(const camera of plan.cameras)for(let round=0;round<2;round++) {
        const view:RenderView={...camera,width:plan.width,height:plan.height,pixelRatio:1,extent:8,
          background:[0,0,0],floor:[0,0,0],exposure:1,roughness:.8,environmentIntensity:0,
          lights:{directional:[],points:[],spots:[],areas:[],ambient:[],hemisphere:[]},
          fog:{kind:"exp2",color:profile.color,density:scenario.density}};
        const metrics=await renderer.validateFrame(view);
        if(metrics.drawCalls<1)throw Error("Author fog production frame is empty");
        const actual=renderer as unknown as {targets:{hdrTexture:GPUTexture};frameData:Float32Array};
        const texture=actual.targets.hdrTexture,bytes=plan.width*plan.height*8;
        const read=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
        try {
          const encoder=device.createCommandEncoder();
          encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:plan.width*8,rowsPerImage:plan.height},[plan.width,plan.height]);
          device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
          const raw=new Uint16Array(read.getMappedRange()),sample=(pixel:number)=>Array.from(raw.slice(pixel*4,pixel*4+4),decodeFloat16Bits);
          const samples=camera.points.map(point=>({pixel:point.pixel,instanceId:point.instanceId,hdr:sample(point.pixel)}));
          const rgbaHash=sha256Utf8(Array.from(raw).join(","));read.unmap();
          frames.push({cameraId:camera.id,scenario:scenario.id,round,samples,rgbaHash,vp:Array.from(actual.frameData.slice(0,16))});
        }finally{if(read.mapState==="mapped")read.unmap();read.destroy();}
        await observe?.(`${camera.id}-${scenario.id}`,round);
      }
    }
    if(renderer.session.diagnostics.length)throw Error("Author fog GPU errors");
    return {passed:true,packageHash:plan.packageHash,packetHash:plan.packetHash,width:plan.width,height:plan.height,
      sourceHash:sha256Utf8(sceneShader),frames,errors:renderer.session.diagnostics};
  }finally{abort.abort();renderer.dispose();}
}
