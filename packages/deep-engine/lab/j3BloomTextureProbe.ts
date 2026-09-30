import {DeviceSession} from "../src/webgpu/deviceSession.js";
import {BLOOM_WGSL} from "../src/postprocess/bloomWgsl.js";
import {DEFAULT_PBR_BLOOM_OPTIONS} from "../src/webgpu/pbrPostProcessChain.js";
import {sha256Utf8} from "../src/shaderPackage/hash.js";
import {encodeFloat16Bits} from "./temporalAaProbe.js";
import {readBloomEnergyCase} from "./bloomEnergyReadback.js";
import {bloomTextureInput,type BloomTextureFixture} from "./j3BloomTextureReference.js";

export async function runJ3BloomTextureProbe(fixture:BloomTextureFixture){
  if(JSON.stringify(fixture.web)!==JSON.stringify(DEFAULT_PBR_BLOOM_OPTIONS))throw Error("Bloom Web production defaults changed");
  const canvas=document.createElement("canvas");canvas.width=fixture.width;canvas.height=fixture.height;
  const session=await DeviceSession.open(canvas,navigator.gpu,new AbortController().signal),frames=[];
  try{
    for(const id of fixture.cases){
      const source=bloomTextureInput(id,fixture.width,fixture.height);
      const inputHash=sha256Utf8(Array.from(source.pixels,encodeFloat16Bits).join(","));
      for(let round=0;round<2;round++){
        const frame=await readBloomEnergyCase(session,fixture.width,fixture.web.maxLevels,(x,y)=>{
          const at=(y*fixture.width+x)*4;return [source.pixels[at]!,source.pixels[at+1]!,source.pixels[at+2]!,source.pixels[at+3]!];
        });
        frames.push({id,round,inputHash,width:frame.size,height:frame.size,levels:frame.levels,passCount:frame.passCount,
          pixels:Array.from(frame.pixels),rgbaHash:sha256Utf8(Array.from(frame.pixels,encodeFloat16Bits).join(","))});
      }
    }
    if(session.diagnostics.length||session.resourceCount!==0)throw Error("Bloom texture GPU/resources unhealthy");
    return {passed:true,profile:"web-production-default-linear-HDR",sourceHash:sha256Utf8(BLOOM_WGSL),
      frames,errors:session.diagnostics,resourcesAfter:session.resourceCount};
  }finally{session.dispose();}
}
