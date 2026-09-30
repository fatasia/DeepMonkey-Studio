import test from "node:test";
import assert from "node:assert/strict";
import {compareCsmTimings} from "./j2CsmTimingParity.mjs";
const plan={cases:[{id:"inactive-uniform"}],sampleFrames:16};
function host(name) {
  const window=(id)=>({schema:"deep-engine.benchmark-sample-window",schemaVersion:1,
    runId:id,clockId:"host-monotonic",windowStartMs:0,windowEndMs:10,
    channels:[{channel:"gpu-timestamp",clockId:"gpu-timestamp",windowStartMs:0,windowEndMs:10,
      availability:"measured",sampleCount:16,samplesMs:Array(16).fill(.2)}]});
  return {passed:true,fixtureHash:"fixture",planHash:"plan",errors:[],results:[{id:"inactive-uniform",
    correctness:["reference","candidate"].map(id=>({id,sourceHash:id,libraryHash:id,values:Array(21).fill(1),maxError:0})),
    pairs:Array.from({length:5},(_,i)=>({round:i+1,order:i%2===0?["reference","candidate"]:["candidate","reference"],
      candidate:window(`${name}-c${i}`),reference:window(`${name}-r${i}`)}))}]};
}
test("uses existing five-pair GPU comparison for each host",async()=>{
  const result=await compareCsmTimings(plan,"fixture","plan",host("w"),host("n"));
  assert.equal(result.timingComplete,true);assert.equal(result.results.length,2);
  assert.deepEqual(result.results[0].comparison.delta95IntervalMs,[0,0]);
});
test("zero and incomplete measured windows fail",async()=>{
  for(const corrupt of ["zero","short","shader","pair","value","order"]) {
    const n=host("n");
    if(corrupt==="zero")n.results[0].pairs[0].candidate.channels[0].samplesMs[0]=0;
    if(corrupt==="short")n.results[0].pairs[0].candidate.channels[0].sampleCount=15;
    if(corrupt==="shader")n.results[0].correctness[0].sourceHash="stale";
    if(corrupt==="pair")n.results[0].pairs.pop();
    if(corrupt==="value")n.results[0].correctness[0].values[0]=.5;
    if(corrupt==="order")n.results[0].pairs[1].order=["reference","candidate"];
    await assert.rejects(compareCsmTimings(plan,"fixture","plan",host("w"),n));
  }
});
test("unavailable queries remain explicitly unverified",async()=>{
  const n=host("n"),c=n.results[0].pairs[0].candidate.channels[0];
  Object.assign(c,{availability:"unavailable",sampleCount:0,samplesMs:[],unavailableReason:"timestamp_query_unsupported"});
  const result=await compareCsmTimings(plan,"fixture","plan",host("w"),n);
  assert.equal(result.passed,true);assert.equal(result.timingComplete,false);
  assert.equal(result.results[1].comparison.status,"unverified");
});
