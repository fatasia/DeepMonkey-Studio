/// <reference types="@webgpu/types" />
import { DeviceSession } from '../src/webgpu/deviceSession.js';
import { WeightedOitPass, weightedOitColorTargets } from '../src/webgpu/weightedOit.js';
import { WEIGHTED_OIT_FRAGMENT_WGSL } from '../src/webgpu/weightedOitWgsl.js';

const SIZE = 128, STRIDE = SIZE * 4;
const shader = `${WEIGHTED_OIT_FRAGMENT_WGSL}
struct Params { color:vec4f, flags:vec4f }; @group(0) @binding(0) var<uniform> p:Params;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let vertices=array<vec2f,6>(vec2f(-.75,-.65),vec2f(.75,-.65),vec2f(.75,.65),vec2f(-.75,-.65),vec2f(.75,.65),vec2f(-.75,.65));
  let v=vertices[i]; return vec4f(v.x*p.flags.y,v.y,.5+v.x*p.flags.z,1.0);
}
@fragment fn fs(@builtin(position) pos:vec4f)->DeepWeightedOitOutput {
  if(p.flags.x>0.5) { return deepWeightedOitPremultiplied(p.color.rgb,p.color.a,pos.z); }
  return deepWeightedOit(p.color.rgb,p.color.a,pos.z);
}`;
interface Layer { color: number[]; premult?: boolean; mirror?: boolean; slope?: number }
interface Case { name: string; layers: Layer[]; double?: boolean }
const red = [0.8,0.15,0.05,0.5], blue = [0.05,0.25,0.8,0.6];
const pre = (c: number[]) => [c[0]! * c[3]!, c[1]! * c[3]!, c[2]! * c[3]!, c[3]!];
const cases: Case[] = [
  { name:'straight', layers:[{color:red}] }, { name:'premultiplied', layers:[{color:pre(red),premult:true}] },
  { name:'empty', layers:[] }, { name:'zero-alpha', layers:[{color:[1,0.5,0.8,0]}] },
  { name:'zero-premultiplied', layers:[{color:[0,0,0,0],premult:true}] },
  { name:'crossing-forward', layers:[{color:red,slope:.35},{color:blue,slope:-.35}] },
  { name:'crossing-reverse', layers:[{color:blue,slope:-.35},{color:red,slope:.35}] },
  { name:'mirror-front', layers:[{color:red,mirror:true}] },
  { name:'mirror-double', layers:[{color:red,mirror:true}], double:true },
];
const output = document.querySelector('pre')!;
const result: Record<string, unknown> = { schemaVersion:1, productionPath:'DeviceSession + weightedOit WGSL/targets/composite; fixture geometry', success:false };
let session: DeviceSession | undefined;
try {
  const surface=document.createElement('canvas'); surface.style.width='128px'; surface.style.height='128px';
  document.body.append(surface);
  session=await DeviceSession.open(surface,navigator.gpu,new AbortController().signal); surface.hidden=true;
  result.adapter=session.adapterInfo;
  if (session.adapterInfo?.isFallbackAdapter !== false || /swiftshader|llvmpipe|software/i.test(session.adapterInfo?.description ?? '')) throw new Error('Hardware adapter not proven');
  const device=session.device, oit=new WeightedOitPass(session); oit.resize(SIZE,SIZE);
  const resources: Array<GPUTexture | GPUBuffer> = [];
  const own=<T extends GPUTexture | GPUBuffer>(r:T):T=>{resources.push(r);return r;};
  device.pushErrorScope('validation');
  const opaque=own(device.createTexture({size:[SIZE,SIZE],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}));
  const layout=device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}}]});
  const module=device.createShaderModule({code:shader});
  const pipeline=(double:boolean)=>device.createRenderPipeline({layout:device.createPipelineLayout({bindGroupLayouts:[layout]}),
    vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[...weightedOitColorTargets()]},
    primitive:{topology:'triangle-list',frontFace:'ccw',cullMode:double?'none':'back'}});
  const front=pipeline(false), both=pipeline(true);
  const pixels=new Map<string, Uint8Array>();
  for(const c of cases) {
    const figure=document.createElement('figure'), canvas=document.createElement('canvas'), caption=document.createElement('figcaption');
    canvas.width=SIZE;canvas.height=SIZE;caption.textContent=c.name;figure.append(canvas,caption);document.querySelector('main')!.append(figure);
    const context=canvas.getContext('webgpu')!;context.configure({device,format:session.format,alphaMode:'opaque'});
    const target=own(device.createTexture({size:[SIZE,SIZE],format:'rgba8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC}));
    const readback=own(device.createBuffer({size:STRIDE*SIZE,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}));
    const encoder=device.createCommandEncoder();
    const background=encoder.beginRenderPass({colorAttachments:[{view:opaque.createView(),clearValue:[.04,.06,.08,1],loadOp:'clear',storeOp:'store'}]}); background.end();
    const pass=encoder.beginRenderPass({colorAttachments:[...oit.accumulationAttachments()]});pass.setPipeline(c.double?both:front);
    for(const l of c.layers) {
      const data=new Float32Array([...l.color,l.premult?1:0,l.mirror?-1:1,l.slope??0,0]);
      const buffer=own(device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));device.queue.writeBuffer(buffer,0,data);
      pass.setBindGroup(0,device.createBindGroup({layout,entries:[{binding:0,resource:{buffer}}]}));pass.draw(6);
    }
    pass.end(); oit.encodeComposite(encoder,opaque.createView(),target.createView(),{outputFormat:'rgba8unorm'});
    oit.encodeComposite(encoder,opaque.createView(),context.getCurrentTexture().createView(),{outputFormat:session.format});
    encoder.copyTextureToBuffer({texture:target},{buffer:readback,bytesPerRow:STRIDE},[SIZE,SIZE]);
    device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();await readback.mapAsync(GPUMapMode.READ);
    pixels.set(c.name,new Uint8Array(readback.getMappedRange()).slice());readback.unmap();
  }
  const delta=(a:string,b:string)=>Math.max(...pixels.get(a)!.map((v,i)=>Math.abs(v-pixels.get(b)![i]!)));
  const comparisons={straightPremultiplied:delta('straight','premultiplied'),zeroStraight:delta('empty','zero-alpha'),
    zeroPremultiplied:delta('empty','zero-premultiplied'),order:delta('crossing-forward','crossing-reverse'),
    mirrorFrontCulled:delta('empty','mirror-front'),mirrorDouble:delta('straight','mirror-double')};
  const changed=delta('straight','empty'), crossingChanged=delta('crossing-forward','straight');
  const samples=Object.fromEntries([...pixels].map(([name,p])=>[name,[32,64,96].map(x=>Array.from(p.slice((64*SIZE+x)*4,(64*SIZE+x)*4+4)))]));
  const validation=await device.popErrorScope();
  oit.dispose();for(const r of resources)r.destroy();
  result.comparisons=comparisons;result.changed=changed;result.crossingChanged=crossingChanged;result.samples=samples;
  result.validation=validation?.message??null;result.diagnostics=session.diagnostics;result.remainingOwnedResources=session.resourceCount;
  const center=pixels.get('straight')!.slice((64*SIZE+64)*4,(64*SIZE+64)*4+4);
  const reference=[107,27,17,255], referenceDelta=Math.max(...center.map((v,i)=>Math.abs(v-reference[i]!)));
  result.referenceDelta=referenceDelta;
  result.success=!validation && !session.diagnostics.length && Object.values(comparisons).every(v=>v<=1) && changed>20 && crossingChanged>10 && referenceDelta<=1;
  (window as any).__c03frames=Object.fromEntries([...pixels].map(([name,p])=>[name,Array.from(p)]));
} catch(error) { result.error=String(error); }
const {samples,...summary}=result;
output.textContent=JSON.stringify(summary,null,2);document.title=result.success?'C03 GPU PASS':'C03 GPU FAIL';
(window as any).__c03=result;
// Keep canvases/devices alive for screenshot capture; browser teardown owns final disposal.
