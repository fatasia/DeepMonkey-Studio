import {createServer} from "node:http";
import {createRequire} from "node:module";
import {mkdir,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import path from "node:path";
const root=fileURLToPath(new URL("../",import.meta.url)),require=createRequire(import.meta.url),out=path.join(root,"test-output/interrupted-0930/probe-gi-actual/storage-conversion");
await mkdir(out,{recursive:true});
const gain=1-(.04*.75+.0625)*(1+.04*(1/.8125-1));
const values=[.86*.25*gain,.28*.5*gain,.055*gain,.86*.25/Math.PI,1+.75*2**-10,.25+.75*2**-12,.5+.5*2**-11,0].map(Math.fround);
function half(bits){const e=(bits>>10)&31,m=bits&1023;return e===0?m*2**-24:(1+m/1024)*2**(e-15);}
const expectations=values.map(value=>{if(value===0)return {value,rtneBits:0,rtzBits:0};const data=new Float32Array([value]),bits=new Uint32Array(data.buffer)[0],e=((bits>>>23)&255)-127+15,m=bits&0x7fffff,lower=(e<<10)|(m>>>13),tail=m&8191;return {value,rtzBits:lower,rtneBits:lower+(tail>4096||(tail===4096&&(lower&1))?1:0)};});
const code=`@group(0) @binding(0) var<storage,read> values: array<vec4f>;
@vertex fn vertex(@builtin(vertex_index) id:u32)->@builtin(position) vec4f { let positions=array(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(positions[id],0,1); }
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f { return values[u32(p.x)]; }`;
const fixture={schema:"j2-b5-fixed-hdr-format-conversion-v1",values,expectations,shader:code,sourceHash:createHash("sha256").update(code).digest("hex"),scope:"one fresh device; same no-arithmetic f32 fragment into rgba32float witness and rgba16float attachments at sampleCount1/4"};
// Immutable inputs and both hypotheses precede adapter/device creation.
await writeFile(path.join(out,"pre-gpu-fixture.json"),JSON.stringify(fixture,null,2));
const server=createServer((_req,res)=>res.end("<!doctype html><meta charset=utf-8><title>HDR conversion probe</title>"));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));let browser;
try{
  const {chromium}=require("../apps/cloud-render-worker/node_modules/playwright-core");browser=await chromium.launch({headless:true,executablePath:process.env.BIM_STUDIO_CHROME_PATH??"C:/Program Files/Google/Chrome/Application/chrome.exe",args:["--enable-unsafe-webgpu"]});
  const cdp=await browser.newBrowserCDPSession(),browserGpu=(await cdp.send("SystemInfo.getInfo")).gpu;
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  const actual=await page.evaluate(async f=>{
    const adapter=await navigator.gpu?.requestAdapter({powerPreference:"high-performance"});if(!adapter)throw Error("No actual WebGPU adapter");const device=await adapter.requestDevice(),errors=[];
    device.addEventListener("uncapturederror",e=>errors.push(e.error.message));device.pushErrorScope("validation");
    const module=device.createShaderModule({code:f.shader});const info=await module.getCompilationInfo();if(info.messages.some(m=>m.type==="error"))throw Error(JSON.stringify(info.messages));
    const storage=device.createBuffer({size:f.values.length*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(storage,0,new Float32Array(f.values.flatMap(v=>[v,v,v,1])));
    const results=[];
    for(const [format,samples] of [["rgba32float",1],["rgba16float",1],["rgba16float",4]]){
      const pipeline=await device.createRenderPipelineAsync({layout:"auto",vertex:{module,entryPoint:"vertex"},fragment:{module,entryPoint:"fragment",targets:[{format}]},multisample:{count:samples}});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:storage}}]});
      const texture=device.createTexture({size:[f.values.length,1],format,sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT|(samples===1?GPUTextureUsage.COPY_SRC:0)});
      const resolved=samples===1?texture:device.createTexture({size:[f.values.length,1],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
      const read=device.createBuffer({size:256,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try{const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[{view:texture.createView(),...(samples===4?{resolveTarget:resolved.createView()}:{}),clearValue:[0,0,0,1],loadOp:"clear",storeOp:"store"}]});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();encoder.copyTextureToBuffer({texture:resolved},{buffer:read,bytesPerRow:256},[f.values.length,1]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const data=read.getMappedRange();results.push({format,samples,lanes:format==="rgba32float"?Array.from(new Float32Array(data).slice(0,f.values.length*4)):Array.from(new Uint16Array(data).slice(0,f.values.length*4))});
      }finally{if(read.mapState==="mapped")read.unmap();read.destroy();texture.destroy();if(resolved!==texture)resolved.destroy();}
    }
    const scoped=await device.popErrorScope();if(scoped)errors.push(scoped.message);storage.destroy();device.destroy();
    const i=adapter.info;return {results,errors,adapter:{vendor:i.vendor,architecture:i.architecture,device:i.device,description:i.description},inputFloat32:f.values};
  },fixture);
  if(actual.errors.length)throw Error(actual.errors.join("\n"));const witness=actual.results[0];
  for(let i=0;i<values.length;i++)for(let lane=0;lane<3;lane++)if(witness.lanes[i*4+lane]!==values[i])throw Error("RGBA32F witness altered uploaded f32 before attachment conversion");
  const classifications=actual.results.slice(1).map(r=>({samples:r.samples,allRTNE:expectations.every((e,i)=>r.lanes[i*4]===e.rtneBits),allRTZ:expectations.every((e,i)=>r.lanes[i*4]===e.rtzBits),allAdjacent:expectations.every((e,i)=>[e.rtzBits,e.rtzBits+1].includes(r.lanes[i*4])),observed:r.lanes.filter((_v,i)=>i%4===0).map(bits=>({bits,value:half(bits)}))}));
  if(classifications.some(c=>!c.allAdjacent))throw Error("Known f32 attachment store outside adjacent binary16 values");
  const evidence={passed:true,currentRun:true,fixture,actual,classifications,browserGpu,scope:fixture.scope};await writeFile(path.join(out,"evidence.json"),JSON.stringify(evidence,null,2));console.log(JSON.stringify({passed:true,adapter:actual.adapter,classifications}));
}finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
