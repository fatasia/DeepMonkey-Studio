import {DeviceSession} from "../src/webgpu/deviceSession.js";
import {VolumetricFogPass} from "../src/fog/volumetricFogPass.js";
import {VolumetricFogCompositePass} from "../src/fog/volumetricFogComposite.js";
import {VOLUMETRIC_FOG_MARCH_WGSL} from "../src/fog/volumetricFogPassWgsl.js";
import {VOLUMETRIC_FOG_COMPOSITE_WGSL} from "../src/fog/volumetricFogCompositeWgsl.js";
import {sha256Utf8} from "../src/shaderPackage/hash.js";
import {decodeFloat16Bits,encodeFloat16Bits} from "./temporalAaProbe.js";
import {fogSourcePixels,fogWebOptions,type FogProfileFixture} from "./j3FogProfileReference.js";

export async function runJ3FogProfileProbe(f:FogProfileFixture){
  const canvas=document.createElement("canvas");canvas.width=f.width;canvas.height=f.height;
  const session=await DeviceSession.open(canvas,navigator.gpu,new AbortController().signal),device=session.device;
  const scopes=( ["validation","out-of-memory","internal"] as const).map(filter=>{device.pushErrorScope(filter);return filter;});
  const owned:Array<GPUTexture|GPUBuffer>=[],own=<T extends GPUTexture|GPUBuffer>(v:T)=>{owned.push(v);return v;};
  const pass=new VolumetricFogPass(session),composite=new VolumetricFogCompositePass(session),frames=[];
  const depth=own(device.createTexture({size:[f.width,f.height],format:"r32float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}));
  const color=own(device.createTexture({size:[f.width,f.height],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}));
  const source=fogSourcePixels(f),sourceBits=Uint16Array.from(source,encodeFloat16Bits),inputHash=sha256Utf8(Array.from(sourceBits).join(","));
  device.queue.writeTexture({texture:color},sourceBits,{bytesPerRow:f.width*8},[f.width,f.height]);
  // Same byte-preserving readback copy as the existing G7 lab; the production scatter allocation has no COPY_SRC.
  const copyModule=device.createShaderModule({code:`@group(0) @binding(0) var source:texture_2d<f32>;
    @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
    @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{return textureLoad(source,vec2i(p.xy),0);}`});
  const copy=device.createRenderPipeline({layout:"auto",vertex:{module:copyModule,entryPoint:"vs"},fragment:{module:copyModule,entryPoint:"fs",targets:[{format:"rgba16float"}]}});
  async function read(texture:GPUTexture,width:number,height:number,needsCopy:boolean){
    const rowBytes=Math.ceil(width*8/256)*256,buffer=device.createBuffer({size:rowBytes*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    let target:GPUTexture|undefined;
    try{
      const encoder=device.createCommandEncoder();
      if(needsCopy){
        target=device.createTexture({size:[width,height],format:"rgba16float",usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
        const render=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:"clear",storeOp:"store",clearValue:[0,0,0,0]}]});
        render.setPipeline(copy);render.setBindGroup(0,device.createBindGroup({layout:copy.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView()}]}));render.draw(3);render.end();
      }
      encoder.copyTextureToBuffer({texture:target??texture},{buffer,bytesPerRow:rowBytes,rowsPerImage:height},[width,height]);
      device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
      const bytes=new DataView(buffer.getMappedRange()),bits=[];
      for(let y=0;y<height;y++)for(let x=0;x<width*4;x++)bits.push(bytes.getUint16(y*rowBytes+x*2,true));
      return {pixels:bits.map(decodeFloat16Bits),hash:sha256Utf8(bits.join(","))};
    }finally{if(buffer.mapState==="mapped")buffer.unmap();buffer.destroy();target?.destroy();}
  }
  try{
    let revision=0;
    for(const profile of f.profiles){
      const rowBytes=Math.ceil(f.width*4/256)*256,upload=new ArrayBuffer(rowBytes*f.height),view=new DataView(upload);
      for(let y=0;y<f.height;y++)for(let x=0;x<f.width;x++)view.setFloat32(y*rowBytes+x*4,profile.sky?0:f.geometryDepth,true);
      device.queue.writeTexture({texture:depth},upload,{bytesPerRow:rowBytes},[f.width,f.height]);
      for(let round=0;round<2;round++){
        const encoder=device.createCommandEncoder(),scatter=pass.encode(encoder,{depth,revision,depthEncoding:"linear-view-depth-positive"},fogWebOptions(f,profile));
        const hdr=composite.encode(encoder,{color,scatter,revision:revision++,colorEncoding:"linear-hdr"});device.queue.submit([encoder.finish()]);
        const a=await read(scatter.texture,scatter.width,scatter.height,true),b=await read(hdr.texture,hdr.width,hdr.height,false);
        frames.push({id:profile.id,round,width:f.width,height:f.height,inputHash,scatter:a.pixels,composite:b.pixels,scatterHash:a.hash,rgbaHash:b.hash});
      }
    }
    while(scopes.length){scopes.pop();const error=await device.popErrorScope();if(error)throw Error(error.message);}
    pass.dispose();composite.dispose();
    if(session.diagnostics.length||session.resourceCount!==0)throw Error("Actual Fog GPU/resources unhealthy");
    return {passed:true,profile:"web-view-origin-standard-HG-scatter-and-linear-HDR",sourceHash:sha256Utf8(VOLUMETRIC_FOG_MARCH_WGSL+"\n"+VOLUMETRIC_FOG_COMPOSITE_WGSL),inputHash,
      frames,errors:session.diagnostics,resourcesAfter:session.resourceCount};
  }finally{while(scopes.length){scopes.pop();await device.popErrorScope().catch(()=>null);}pass.dispose();composite.dispose();for(const resource of owned)resource.destroy();session.dispose();}
}
