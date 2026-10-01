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
/**
 * J3 Gate D roughness channel semantics of the actual normal MRT alpha (2026-10-01 归因修正)。
 *
 * 读回通道是 normal 附件 alpha,不是 HDR alpha;但两端 alpha 的语义不同:
 * - Web `view-normal` 附件(`rgba8unorm`,见 pbrFramePlanResources)由 `pbrShader.geometryOutput`
 *   写入 `clamp(surface.rough, 0, 1)` —— **原始感知 roughness**(材质 roughness × MR 纹理 G,
 *   clamp 前的 SSR 锥滤波语义),不是 shade 消费后的值。
 * - Native `fragment_normal_capture`(native_mesh_v1.wgsl)写入的是**消费后**形式
 *   `min(1, clamp(raw, 0.045, 1) + viewGeometryRoughness)`。
 *
 * 两者在冻结 J3 fixture 上按构造重合(平面四边形 ⇒ 几何项为 0;raw ≥ 0.339 ⇒ 0.06/0.045
 * 两个下限都不咬合),8bit 量化后逐点相等 —— 这正是历史上"输入一致"排除依据碰巧成立的原因。
 * 曲面几何或 raw < 0.06 时两者必然发散( latent:Web 0.06 vs Native 0.045 下限差)。
 */
export const textureCoverageNormalAlphaSemantics={web:"raw-perceptual-roughness",native:"consumed-shading-roughness"} as const;
/** Web shade 消费语义的 roughness(下限 0.06,见 pbrShader.shade;几何项为片元导数,
 * 附件读回不可复现,平面 fixture 上为 0;Native 用 0.045 下限,差异保留为显式发散)。 */
export function consumedShadingRoughness(rawNormalAlpha:number){
  return Math.min(1,Math.max(.06,rawNormalAlpha));
}
interface Attachments {
  targets:{hdrTexture:GPUTexture;normalTexture:GPUTexture};
  transparency:{currentColor?:GPUTexture};frameData:Float32Array;
}
export async function readTextureCoverageFrame(renderer:PbrRenderer,transparent:boolean){
  const actual=renderer as unknown as Attachments,device=renderer.session.device;
  const color=transparent?actual.transparency.currentColor:actual.targets.hdrTexture;
  if(!color||color.format!=="rgba16float"||!actual.targets.normalTexture)throw Error("Actual final HDR/normal attachment unavailable");
  if(actual.targets.normalTexture.format!=="rgba8unorm")throw Error("Actual normal attachment is not the formal rgba8unorm MRT (roughness alpha quantization contract)");
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
