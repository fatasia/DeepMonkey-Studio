import test from "node:test";
import assert from "node:assert/strict";
import {compareAuthorFog} from "./j3AuthorFogParity.mjs";
const scenarios=["control","density-low","density-high","material-opt-out"].map(id=>({id}));
const cameras=["axis","oblique"].map(id=>({id,expectedVP:Array(16).fill(0),points:[{pixel:23,instanceId:"tri",expected:Object.fromEntries(scenarios.map(s=>[s.id,[.5,.25,.125]]))}]}));
const plan={packageHash:"p",packetHash:"r",width:128,height:128,cameras,profile:{scenarios,cpuAbsoluteTolerance:.001,crossHostAbsoluteTolerance:.001}};
function host(){return {passed:true,packageHash:"p",packetHash:"r",width:128,height:128,errors:[],
  frames:cameras.flatMap(camera=>scenarios.flatMap(s=>[0,1].map(round=>({cameraId:camera.id,scenario:s.id,round,
    rgbaHash:s.id==="material-opt-out"?"control":s.id,vp:Array(16).fill(0),samples:[{pixel:23,instanceId:"tri",hdr:[.5,.25,.125,1]}]}))))};}
test("checks complete frozen matrix and exact opt-out controls",()=>{
  const result=compareAuthorFog(plan,host(),host());assert.equal(result.pointsCompared,16);assert.equal(result.maxCrossError,0);
});
test("rejects opt-out, missing edge points and actual pixel/alpha drift",()=>{
  for(const kind of ["optout","missing","pixel","alpha","cpu"]){
    const n=host();
    if(kind==="optout")n.frames.find(f=>f.scenario==="material-opt-out").rgbaHash="fogged";
    if(kind==="missing")n.frames[0].samples=[];
    if(kind==="pixel")n.frames[0].samples[0].pixel=24;
    if(kind==="alpha")n.frames[0].samples[0].hdr[3]=0;
    if(kind==="cpu")n.frames[0].samples[0].hdr[0]=.6;
    assert.throws(()=>compareAuthorFog(plan,host(),n));
  }
});
