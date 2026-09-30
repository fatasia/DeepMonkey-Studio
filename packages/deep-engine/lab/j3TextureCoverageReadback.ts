import {sha256Utf8} from "../src/shaderPackage/hash.js";
import {sceneShader} from "../src/webgpu/pbrShader.js";
import type {PbrRenderer} from "../src/webgpu/pbrRenderer.js";

/** Observe actual formal module creation without editing its code or descriptors. */
export function observeTextureCoverageGpu(gpu:GPU){
  const modules:{label:string;hash:string;count:number}[]=[],restore:(()=>void)[]=[],devices:GPUDevice[]=[];
  // C21 added the SDR format negotiation on the session open path; the wrapper
  // must forward it (and prefer canvas format probes) alongside requestAdapter.
  const wrapped={getPreferredCanvasFormat:()=>gpu.getPreferredCanvasFormat(),
    requestAdapter:async(options?:GPURequestAdapterOptions)=>{
    const adapter=await gpu.requestAdapter(options);if(!adapter)return null;
    return new Proxy(adapter,{get(target,key){
      if(key!=="requestDevice"){const v=Reflect.get(target,key,target);return typeof v==="function"?v.bind(target):v;}
      return async(descriptor?:GPUDeviceDescriptor)=>{
        const device=await target.requestDevice(descriptor),property=Object.getOwnPropertyDescriptor(device,"createShaderModule"),original=device.createShaderModule.bind(device);
        devices.push(device);
        Object.defineProperty(device,"createShaderModule",{configurable:true,value:(d:GPUShaderModuleDescriptor)=>{
          if(d.label==="Deep PBR"){
            const hash=sha256Utf8(d.code),record=modules.find(v=>v.hash===hash);
            if(record)record.count++;else modules.push({label:d.label,hash,count:1});
          }
          return original(d);
        }});
        restore.push(()=>{if(property)Object.defineProperty(device,"createShaderModule",property);else Reflect.deleteProperty(device,"createShaderModule");});
        return device;
      };
    }});
  }} as unknown as GPU;
  return {gpu:wrapped,modules,finish(){
    if(!modules.some(v=>v.hash===sha256Utf8(sceneShader)&&v.count>0))throw Error("Actual formal texture module not observed");
    return {sourceHash:sha256Utf8(sceneShader),modules};
  },dispose(){for(const fn of restore.reverse())fn();for(const d of devices)d.destroy();}};
}
const READBACK=/* wgsl */`
@group(0) @binding(0) var hdr:texture_2d<f32>;
@group(0) @binding(1) var normals:texture_2d<f32>;
struct Pixel { color:vec4f, normal:vec4f }
@group(0) @binding(2) var<storage,read_write> result:array<Pixel>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(hdr);if(id.x>=size.x*size.y){return;}
  let p=vec2i(i32(id.x%size.x),i32(id.x/size.x));
  result[id.x].color=textureLoad(hdr,p,0);result[id.x].normal=textureLoad(normals,p,0);
}`;
interface Attachments {
  targets:{hdrTexture:GPUTexture;normalTexture:GPUTexture};
  transparency:{currentColor?:GPUTexture};frameData:Float32Array;
}
export async function readTextureCoverageFrame(renderer:PbrRenderer,transparent:boolean){
  const actual=renderer as unknown as Attachments,device=renderer.session.device;
  const color=transparent?actual.transparency.currentColor:actual.targets.hdrTexture;
  if(!color||color.format!=="rgba16float"||!actual.targets.normalTexture)throw Error("Actual final HDR/normal attachment unavailable");
  if(transparent&&color===actual.targets.hdrTexture)throw Error("OIT profile must capture actual composited destination");
  const size=color.width*color.height*32,output=device.createBuffer({size,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=device.createBuffer({size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
  try{
    const pipeline=await device.createComputePipelineAsync({layout:"auto",compute:{module:device.createShaderModule({code:READBACK}),entryPoint:"main"}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:color.createView()},{binding:1,resource:actual.targets.normalTexture.createView()},{binding:2,resource:{buffer:output}}]});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(color.width*color.height/64));pass.end();
    encoder.copyBufferToBuffer(output,0,read,0,size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const data=new Float32Array(read.getMappedRange()).slice();
    if(!data.every(Number.isFinite))throw Error("Texture actual attachments contain nonfinite values");
    return {data,fullHash:sha256Utf8(Array.from(data.filter((_,i)=>i%8<4)).join(",")),normalHash:sha256Utf8(Array.from(data.filter((_,i)=>i%8>=4)).join(",")),vp:Array.from(actual.frameData.slice(0,16)),frame:Array.from(actual.frameData),finalAttachment:transparent?"weighted-oit-composited-hdr":"opaque-hdr"};
  }finally{if(read.mapState==="mapped")read.unmap();read.destroy();output.destroy();}
}
