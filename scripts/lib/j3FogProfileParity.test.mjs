import test from "node:test";
import assert from "node:assert/strict";
import {compareFogProfiles} from "./j3FogProfileParity.mjs";
const hash="f".repeat(64),p={id:"volume-base",density:.04,height:8,g:0,steps:32,sky:false};
const fixture={width:2,height:2,near:.1,far:100,focal:2.05,geometryDepth:10,color:[.0625,.25,.5],light:[0,0,-1],nativeEyeY:[0,8],profiles:[p],nativeOnly:[],absoluteTolerance:.003,relativeTolerance:.004};
const pixels=[.1,.2,.3,1,.1,.2,.3,.25,.1,.2,.3,.5,.1,.2,.3,0],scatter=[.1,.2,.3,.8];
function frame(eye){const f=Array.from({length:149},()=>[0,0,0,0]);f[0][0]=2.05;f[1][1]=2.05;f[2][3]=-1;f[3][1]=-2.05*eye;f[8][1]=eye;f[11]=[0,0,-1,0];f[12]=[.0625,.25,.5,.04];f[143]=[.1,100,1,0];f[148]=[32,8,0,1];return f;}
const plans={inputHash:hash,web:[{id:p.id,scatter,composite:pixels}],native:[0,8].map(eyeY=>({id:p.id,eyeY,pixels}))};
const web={passed:true,inputHash:hash,sourceHash:hash,errors:[],frames:[0,1].map(round=>({id:p.id,round,width:2,height:2,inputHash:hash,scatter,composite:pixels,rgbaHash:hash,scatterHash:hash}))};
const native={passed:true,inputHash:hash,sourceHash:hash,errors:[],frames:[0,8].flatMap(eyeY=>[0,1].map(round=>({id:p.id,eyeY,round,width:2,height:2,inputHash:hash,frame:frame(eyeY),rawDepth:Math.fround(100/99.9-.1*100/(99.9*10)),pixels,rgbaHash:(eyeY?"b":"a").repeat(64)})))};
test("checks every actual legal host profile and preserves world-height distinction",()=>{
  const result=compareFogProfiles(fixture,plans,web,native);assert.equal(result.pixelsCompared,26);assert.equal(result.comparisons.length,8);
});
test("rejects missing profile, changed uniform, alpha, depth and world height",()=>{
  for(const edit of [n=>n.frames.pop(),n=>n.frames[0].frame[148][2]=.7,n=>n.frames[0].pixels[3]=.999,n=>n.frames[0].rawDepth=.5,n=>n.frames.forEach(x=>x.rgbaHash=hash)]){
    const n=structuredClone(native);edit(n);assert.throws(()=>compareFogProfiles(fixture,plans,web,n));
  }
});
