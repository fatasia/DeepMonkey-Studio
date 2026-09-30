import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { GpuTimer } from "../src/webgpu/gpuTimer.js";
import { createSampleWindow } from "../src/benchmarkSampleSchema.js";
import { compareBenchmarkWindows, type BenchmarkWindowPair } from "../src/benchmarkWindowComparison.js";
import { referenceCsmVisibility, type CsmBoundaryFixture } from "./j2CsmBoundaryFixture.js";
import { csmTimingOrder, csmTimingReference, csmTimingShader, type CsmTimingPlan } from "./j2CsmTimingSource.js";
import { csmTimingResources } from "./j2CsmTimingResources.js";

export async function runJ2CsmTimingProbe(canvas: HTMLCanvasElement, source: string, entry: string,
  plan: CsmTimingPlan, fixture: CsmBoundaryFixture) {
  const session=await DeviceSession.open(canvas,navigator.gpu,new AbortController().signal);
  const device=session.device,timer=new GpuTimer(session);timer.enabled=true;
  const resources=await csmTimingResources(device,fixture,plan.width,plan.height);
  const reference=csmTimingReference(source), results=[];
  let frame=0;
  try {
    for(const row of plan.cases) {
      const variants=await Promise.all((["reference","candidate"] as const).map(async id=>{
        const shader=csmTimingShader(id==="candidate"?source:reference,entry,row.depths,fixture.uvXs);
        const module=device.createShaderModule({code:shader.code});
        const pipeline=await device.createRenderPipelineAsync({layout:"auto",vertex:{module,entryPoint:"probeVertex"},
          fragment:{module,entryPoint:"probeFragment",targets:[{format:"rgba32float"}]}});
        return {id,...shader,pipeline,bind:resources.bind(pipeline)};
      }));
      const render=async (variant:typeof variants[number],measured:boolean,capture=false)=>{
        const encoder=device.createCommandEncoder();
        const timed=measured?timer.begin(frame):undefined;
        const pass=encoder.beginRenderPass({colorAttachments:[{view:resources.view,clearValue:[0,0,0,1],
          loadOp:"clear",storeOp:"store"}],...(timed?{timestampWrites:{querySet:timed.queries,
            beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}}:{})});
        pass.setPipeline(variant.pipeline);pass.setBindGroup(0,variant.bind);
        for(let draw=0;draw<plan.drawsPerSample;draw++)pass.draw(3);
        pass.end();timed?.resolve(encoder);
        if(capture)encoder.copyTextureToBuffer({texture:resources.target},{buffer:resources.read,
          bytesPerRow:resources.bytesPerRow},[plan.width,1]);
        device.queue.submit([encoder.finish()]);timed?.read();frame++;
        await device.queue.onSubmittedWorkDone();
        if(measured)await timer.collect(0,frame);
        if(!capture)return;
        await resources.read.mapAsync(GPUMapMode.READ);
        const raw=new Float32Array(resources.read.getMappedRange());
        const values=Array.from({length:21},(_,i)=>raw[i*4]!);resources.read.unmap();
        return values;
      };
      const correctness=[];
      for(const variant of variants) {
        const values=(await render(variant,false,true))!;
        const expected=values.map((_,i)=>referenceCsmVisibility(fixture,{blendStart:1.8,filter:"linear",pattern:"constant"},
          row.depths[i%3]!,fixture.uvXs[i%7]!));
        const maxError=Math.max(...values.map((value,i)=>Math.abs(value-expected[i]!)));
        if(!Number.isFinite(maxError)||maxError>fixture.maxError)throw Error(`${row.id}/${variant.id} CPU oracle failed`);
        correctness.push({id:variant.id,sourceHash:variant.sourceHash,libraryHash:variant.libraryHash,values,maxError});
      }
      const pairs:Array<BenchmarkWindowPair & {order:readonly string[]}>=[];
      for(let round=1;round<=plan.pairedRounds;round++) {
        const windows=new Map();
        for(const id of csmTimingOrder(round)) {
          const variant=variants.find(value=>value.id===id)!;
          for(let i=0;i<plan.warmupFrames;i++)await render(variant,false);
          const start=performance.now(),first=frame;
          for(let i=0;i<plan.sampleFrames;i++)await render(variant,true);
          const timings=await timer.collect(first,frame-1),end=performance.now();
          const measured=timings.length===plan.sampleFrames&&timings.every(value=>value.milliseconds>0);
          const window=createSampleWindow({schema:"deep-engine.benchmark-sample-window",schemaVersion:1,
            runId:`web-${row.id}-${id}-${round}`,clockId:"performance-now",windowStartMs:start,windowEndMs:end,
            channels:[{channel:"gpu-timestamp",clockId:"gpu-timestamp",sampleCount:measured?timings.length:0,
              samplesMs:measured?timings.map(value=>value.milliseconds):[],windowStartMs:start,windowEndMs:end,
              availability:measured?"measured":"unavailable",...(!measured?{unavailableReason:!timer.supported
                ?"timestamp_query_unsupported":"timestamp_zero_quantization_or_incomplete_window"}:{})}]});
          windows.set(id,{...window,observedSamplesMs:timings.map(value=>value.milliseconds)});
        }
        pairs.push({round,order:csmTimingOrder(round),candidate:windows.get("candidate"),reference:windows.get("reference")});
      }
      results.push({id:row.id,correctness,pairs,comparison:compareBenchmarkWindows(pairs)});
    }
    if(session.hasErrors)throw Error("GPU validation failed in CSM timing probe");
    return {passed:true,scope:"same-device-CSM-function-reference-candidate",adapter:session.adapterInfo,
      results,errors:session.diagnostics,timerDiagnostics:timer.diagnostics};
  } finally {resources.destroy();session.dispose();}
}
