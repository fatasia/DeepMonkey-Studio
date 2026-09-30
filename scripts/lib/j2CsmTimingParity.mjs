import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require=createRequire(import.meta.url);

async function loadWindowComparison() {
  const {build}=require("../../packages/deep-engine/node_modules/esbuild");
  const result=await build({entryPoints:[fileURLToPath(new URL("../../packages/deep-engine/src/benchmarkWindowComparison.ts",import.meta.url))],
    bundle:true,format:"esm",platform:"node",write:false});
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
}

export async function compareCsmTimings(plan,fixtureHash,planHash,web,native) {
  const {compareBenchmarkWindows}=await loadWindowComparison();
  for(const host of [web,native]) {
    if(!host?.passed||host.fixtureHash!==fixtureHash||host.planHash!==planHash||host.errors?.length)
      throw Error("CSM timing host correctness/identity failed");
    if(host.results.length!==plan.cases.length)throw Error("CSM timing case matrix changed");
  }
  const results=[];
  for(const [i,row] of plan.cases.entries()) {
    const wr=web.results[i],nr=native.results[i];
    if(wr.id!==row.id||nr.id!==row.id)throw Error("CSM timing case identity changed");
    for(const variant of ["reference","candidate"]) {
      const w=wr.correctness.find(v=>v.id===variant),n=nr.correctness.find(v=>v.id===variant);
      if(!w||!n||!w.sourceHash||w.sourceHash!==n.sourceHash||w.libraryHash!==n.libraryHash)
        throw Error("Actual CSM timing shader identities differ across hosts");
      if(w.values.length!==21||n.values.length!==21||![w.maxError,n.maxError].every(v=>Number.isFinite(v)&&v<=2e-6)
        ||w.values.some((v,j)=>!Number.isFinite(v)||Math.abs(v-n.values[j])>2e-6))
        throw Error("Actual CSM timing correctness differs across hosts");
    }
    for(const [host,value] of [["web",wr],["native",nr]]) {
      if(value.pairs.length!==5)throw Error("Five complete paired timing windows required");
      for(const [j,pair] of value.pairs.entries()) {
        if(pair.round!==j+1)throw Error("Timing rounds changed");
        const order=j%2===0?["reference","candidate"]:["candidate","reference"];
        if(JSON.stringify(pair.order)!==JSON.stringify(order))throw Error("Actual paired execution order changed");
        for(const variant of ["reference","candidate"]) {
          const c=pair[variant]?.channels?.find(c=>c.channel==="gpu-timestamp");
          if(!c)throw Error("Timing GPU channel missing");
          if(c.availability==="measured"&&(c.sampleCount!==plan.sampleFrames||c.samplesMs.some(v=>!Number.isFinite(v)||v<=0)))
            throw Error("Measured timing window is incomplete or contains zero quantization");
        }
      }
      const comparison=compareBenchmarkWindows(value.pairs).find(c=>c.channel==="gpu-timestamp");
      results.push({id:row.id,host,comparison});
    }
  }
  return {passed:true,timingComplete:results.every(r=>r.comparison.status==="measured"),results,
    scope:"same-physical-device-two-API-hosts-CSM-receiver-function-timing",
    excluded:["full production frame FPS improvement","other physical GPUs","shadow-map draw timing"]};
}
