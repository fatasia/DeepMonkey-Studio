import {beforeAll,describe,expect,it} from "vitest";
import type {SceneSnapshot,PrimitiveState} from "@bim-studio/contracts";
import {preparePathTraceAuthor,type PathTraceAuthorPrepared} from "./pathTraceAuthorPreparation";
import {PathTraceAuthorSession} from "./pathTraceAuthorSession";
import {PathTraceAuthorBandHost} from "./pathTraceAuthorBandHost";
import {PathTraceParallelRender} from "./pathTraceAuthorParallel";
import type {PathTraceAuthorWorkerInput,PathTraceAuthorWorkerOutput,PathTraceBandWorker} from "./pathTraceAuthorWorkerTypes";
import {DEFAULT_ENVIRONMENT,DEFAULT_LIGHTING} from "../appDefaults";

function scene():SceneSnapshot{
  const sphere:PrimitiveState={modelId:"sphere",name:"PBR sphere",kind:"sphere",visible:true,opacity:1,color:"#b09060",
    transform:{position:{x:0,y:0,z:0},rotation:{x:.2,y:.3,z:.4},scale:{x:1.3,y:.8,z:1}},material:{doubleSided:true,roughness:1,metalness:.5,ior:1.5}};
  return {schemaVersion:1,id:"author",projectId:"p",name:"PT authored",models:[],primitives:[sphere],measurements:[],
    camera:{mode:"orbit",position:{x:0,y:0,z:3},target:{x:0,y:0,z:0}},createdAt:"",updatedAt:"",
    environment:structuredClone(DEFAULT_ENVIRONMENT),lighting:structuredClone(DEFAULT_LIGHTING),weather:"sunny"};
}
const W=12,H=7;
const base={width:W,height:H,maxSamples:4096,minSamples:8,varianceThreshold:.15,maxAccumulationBytes:W*H*24,sampleSeed:0xc0ffee};
const options={loadModel:async()=>new Uint8Array()};
const prepare=(config:Partial<typeof base>={})=>preparePathTraceAuthor(scene(),{...base,...config},"white-furnace-reference",options);

/** Runs the real band host behind a structured-clone boundary, like a Worker, without a thread. */
class FakeWorker implements PathTraceBandWorker{
  static all:FakeWorker[]=[];onmessage:PathTraceBandWorker["onmessage"]=null;onerror:PathTraceBandWorker["onerror"]=null;
  terminated=false;steps=0;private readonly host=new PathTraceAuthorBandHost();
  constructor(){FakeWorker.all.push(this);}
  postMessage(command:PathTraceAuthorWorkerInput){
    const copy=command.kind==="init"?structuredClone(command):command;if(command.kind==="step")this.steps++;
    setImmediate(()=>{if(this.terminated)return;const out=this.host.handle(copy);if(out)this.onmessage?.({data:out as PathTraceAuthorWorkerOutput});});
  }
  terminate(){this.terminated=true;this.host.handle({kind:"dispose"});}
}
const make=(prepared:PathTraceAuthorPrepared,workers:number,extra={})=>{FakeWorker.all=[];
  return new PathTraceParallelRender(prepared,()=>new FakeWorker(),{workers,stripeRows:1,previewIntervalMs:0,...extra});};
const run=(render:PathTraceParallelRender,signal=new AbortController().signal)=>{const frames:number[]=[];
  return render.run(signal,progress=>frames.push(progress.samples)).then(()=>frames);};
const withoutParallel=(receipt:object)=>{const {parallel:_,...rest}=receipt as Record<string,unknown>;return rest;};

describe("parallel band coordinator over the real band host",()=>{
  let converged:PathTraceAuthorPrepared;
  beforeAll(async()=>{converged=await prepare();});
  it("N=1 reproduces the single-process session byte-for-byte: HDR bytes, spp, noise, receipt",async()=>{
    const reference=new PathTraceAuthorSession(converged);
    await reference.accumulate(new AbortController().signal,async()=>{},()=>{});
    const expected=reference.export(false,converged.sourceHash);
    const render=make(converged,1);await run(render);
    const actual=await render.exportHdr(false,converged.sourceHash);
    expect(actual.bytes).toEqual(expected.bytes);
    expect(withoutParallel(actual.receipt)).toEqual(expected.receipt);
    expect(actual.receipt.parallel.workers).toBe(1);expect(actual.receipt.parallel.seed).toBe(0xc0ffee);
    expect(expected.receipt.samples).toBeGreaterThanOrEqual(8);expect(expected.receipt.converged).toBe(true);
    expect(FakeWorker.all.every(worker=>worker.terminated)).toBe(true);
    reference.dispose();
  });
  it.each([2,3,5])("N=%i matches N=1 exactly (same spp, same HDR bytes) and keeps equal spp on every band",async workers=>{
    const one=make(converged,1);await run(one);const expected=await one.exportHdr(false,converged.sourceHash);
    const render=make(converged,workers);await run(render);
    expect(FakeWorker.all).toHaveLength(workers);
    const steps=FakeWorker.all.map(worker=>worker.steps);expect(new Set(steps).size).toBe(1);
    const actual=await render.exportHdr(false,converged.sourceHash);
    expect(actual.receipt.samples).toBe(expected.receipt.samples);expect(actual.bytes).toEqual(expected.bytes);
    expect(actual.receipt.parallel.bandRows.reduce((a,b)=>a+b,0)).toBe(H);
    expect(actual.receipt.noise).toBe(expected.receipt.noise);
  });
  it("is reproducible for the same seed and worker count and differs only with the seed",async()=>{
    const capped=await prepare({maxSamples:20,minSamples:4,varianceThreshold:1e-9}),other=await prepare({maxSamples:20,minSamples:4,varianceThreshold:1e-9,sampleSeed:7});
    const image=async(prepared:PathTraceAuthorPrepared,workers:number)=>{const render=make(prepared,workers);await run(render);return (await render.exportHdr(true,prepared.sourceHash)).bytes;};
    const a=await image(capped,3);expect(await image(capped,3)).toEqual(a);expect(await image(other,3)).not.toEqual(a);
  });
  it("preview export of an unconverged run is labelled preview and final export is refused",async()=>{
    const capped=await prepare({maxSamples:6,minSamples:4,varianceThreshold:1e-9}),render=make(capped,2);await run(render);
    await expect(render.exportHdr(false,capped.sourceHash)).rejects.toThrow(/convergence/);
    const out=await render.exportHdr(true,capped.sourceHash);
    expect(out.receipt).toMatchObject({preview:true,converged:false,eligibleFinal:false,samples:6,sessionReceipt:undefined});
    const frame=await render.frame();expect(frame.data).toHaveLength(W*H*4);expect(frame.samples).toBe(6);expect(frame.converged).toBe(false);
    render.dispose();
  });
  it("requestStop ends after the sample in flight and keeps a consistent partial image",async()=>{
    const render=make(converged,3),frames:number[]=[];
    await render.run(new AbortController().signal,progress=>{frames.push(progress.samples);if(!progress.done&&frames.length===2)render.requestStop();});
    expect(render.session.sampleCount).toBeLessThan(40);expect(frames.at(-1)).toBe(render.session.sampleCount);
    const out=await render.exportHdr(true,converged.sourceHash);expect(out.receipt.preview).toBe(true);
    expect(out.receipt.samples).toBe(render.session.sampleCount);
  });
  it("cancel terminates every worker at once, releases the lease and rejects the in-flight run",async()=>{
    const render=make(converged,4),promise=run(render);
    await new Promise(resolve=>setTimeout(resolve,15));
    render.cancel();
    await expect(promise).rejects.toMatchObject({name:"AbortError"});
    expect(FakeWorker.all.every(worker=>worker.terminated)).toBe(true);
    expect(render.session.residentBytes).toBe(0);render.cancel();
    await expect(render.exportHdr(true,converged.sourceHash)).rejects.toThrow();
  });
  it("aborting via the signal terminates all workers",async()=>{
    const controller=new AbortController(),render=make(converged,3),promise=run(render,controller.signal);
    await new Promise(resolve=>setTimeout(resolve,10));controller.abort();
    await expect(promise).rejects.toThrow();expect(FakeWorker.all.every(worker=>worker.terminated)).toBe(true);
    expect(render.session.residentBytes).toBe(0);
  });
  it("rejects a stale scene at export and a worker failure tears the whole pool down",async()=>{
    const render=make(converged,2);await run(render);
    await expect(render.exportHdr(true,"stale")).rejects.toThrow(/场景已修改/);expect(FakeWorker.all.every(worker=>worker.terminated)).toBe(true);
    const failing=make(converged,2);
    const original=FakeWorker.all[0]!;original.postMessage=()=>{setTimeout(()=>original.onmessage?.({data:{kind:"failed",message:"boom"}}),0);};
    await expect(run(failing)).rejects.toThrow("boom");expect(FakeWorker.all.every(worker=>worker.terminated)).toBe(true);
  });
  it("rejects an over-budget accumulation before any worker exists",async()=>{
    const tiny=await prepare({maxAccumulationBytes:16});FakeWorker.all=[];
    expect(()=>make(tiny,2)).toThrow(/内存预算/);expect(FakeWorker.all).toHaveLength(0);
  });
});
