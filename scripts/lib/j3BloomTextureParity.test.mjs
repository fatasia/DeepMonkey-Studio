import test from "node:test";
import assert from "node:assert/strict";
import {compareBloomTextures} from "./j3BloomTextureParity.mjs";
const hash="f".repeat(64),fixture={width:2,height:2,cases:["spot"],web:{maxLevels:5},absoluteTolerance:.003,relativeTolerance:.004};
const pixels=[1,2,3,.25,1,2,3,.5,1,2,3,1,1,2,3,0];
const plans=[{id:"spot",inputHash:hash,web:pixels,native:{display:pixels,blurred:[1,2,3,1]}}];
const web={passed:true,errors:[],sourceHash:hash,frames:[0,1].map(round=>({id:"spot",round,inputHash:hash,width:2,height:2,levels:5,passCount:20,pixels,rgbaHash:hash}))};
const native={passed:true,errors:[],sourceHash:hash,frames:[0,1].map(round=>({id:"spot",round,inputHash:hash,width:2,height:2,blurredWidth:1,blurredHeight:1,blurred:[1,2,3,1],display:pixels,blurredHash:hash,displayHash:hash}))};
test("all actual profile pixels compare without cross-algorithm equality gate",()=>{
  const result=compareBloomTextures(fixture,plans,web,native);assert.equal(result.pixelsCompared,18);assert.equal(result.comparisons.length,6);
  assert(result.differences.every(d=>d.maxAbsolute>0));
});
test("rejects missing input, pixel, alpha and unstable actual output",()=>{
  for(const edit of [n=>n.frames[0].inputHash="old",n=>n.frames[0].display.pop(),n=>n.frames[0].display[3]=.251,n=>n.frames[1].displayHash="0".repeat(64),n=>n.frames[0].blurred[0]=5]){
    const altered=structuredClone(native);edit(altered);assert.throws(()=>compareBloomTextures(fixture,plans,web,altered));
  }
});
