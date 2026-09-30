import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {halfFloatInterval} from "./j3ShadowVisibilityIntervals.mjs";
const hash=v=>createHash("sha256").update(v).digest("hex");
const stable=v=>JSON.stringify(v&&typeof v==="object"?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
export function validateProbeActualIdentity(host,family,expectedPacket,fixture,webShaderHash){
  assert.equal(hash(host.actualPacketJson),host.actualPacketHash,"actual submitted packet hash");
  assert.equal(stable(JSON.parse(host.actualPacketJson)),stable(host.actualPacket),"packet text matches observed packet");
  assert.equal(stable(host.actualPacket),stable(expectedPacket),"actual submitted material mutations differ from frozen oracle");
  if(family==="web"){
    assert.equal(host.sourceHash,webShaderHash,"actual ordinary stock shader identity");
    const s=host.sourceAssembly;assert.equal(s.factory,"pipelines.ts moduleCode");assert.equal(s.deformation,false);assert.equal(s.textureArrays,false);assert.equal(s.layeredMaterials,false);
    assert.equal(s.vertex,"vertexMain");assert.equal(s.fragment,"fragmentMain");assert(s.compileRecords.some(r=>r.label==="Deep forward PBR plain/depth/ccw"&&!r.failed));
  }else{assert.equal(host.sourceAssembly.factory,"native_mesh_wgsl::native_mesh_shader_source");assert.equal(host.sourceAssembly.vertex,"vertex_main");assert.equal(host.sourceAssembly.fragment,"fragment_main");}
  assert.equal(host.probeInputs.length,3);
  for(const s of fixture.scenarios){const input=host.probeInputs.find(v=>v.id===s.id);assert(input,"complete actual uniform profiles");
    if(family==="native"){
      const bytes=Buffer.from(input.packedBytes);assert.equal(bytes.length,28*96);assert.equal(hash(bytes),input.packedHash);
      for(let k=0;k<3;k++){assert.equal(bytes.readFloatLE(k*4),fixture.origin[k]);assert.equal(bytes.readFloatLE(16+k*4),3);assert.equal(bytes.readFloatLE(32+k*4),fixture.origin[k]+3*fixture.spacing);}
      assert.equal(bytes.readFloatLE(12),fixture.spacing);assert.equal(bytes.readFloatLE(28),1);assert.equal(bytes.readFloatLE(44),27);
      for(let p=1;p<=27;p++){for(let k=0;k<3;k++)assert.equal(bytes.readFloatLE(p*96+k*4),s.irradiance[k]);assert.equal(bytes.readFloatLE(p*96+12),1);assert.equal(bytes.readFloatLE(p*96+16),100000);assert.equal(bytes.readFloatLE(p*96+20),1);for(let k=6;k<24;k++)assert.equal(bytes.readFloatLE(p*96+k*4),0);}
    }else{
      assert.equal(input.textureHalfBits.length,27*4);assert.equal(hash(input.textureHalfBits.join(",")),input.textureHash);assert.equal(input.metadataBytes.length,256);assert.equal(hash(input.metadataBytes.join(",")),input.metadataHash);
      const bits=s.id==="zero"?[0,0,0,0x3c00]:s.id==="uniform-a"?[0x3400,0x3800,0x3c00,0x3c00]:[0x3800,0x3c00,0x4000,0x3c00];for(let p=0;p<27;p++)assert.deepEqual(input.textureHalfBits.slice(p*4,p*4+4),bits);
      const bytes=Buffer.from(input.metadataBytes);for(let k=0;k<3;k++){assert.equal(bytes.readFloatLE(k*4),fixture.origin[k]);assert.equal(bytes.readUInt32LE(16+k*4),3);assert.equal(bytes.readFloatLE(48+k*4),fixture.origin[k]+2*fixture.spacing);}assert.equal(bytes.readFloatLE(12),fixture.spacing);assert.equal(bytes.readUInt32LE(60),27);assert(bytes.subarray(64).every(v=>v===0));
    }
  }
  for(const f of host.frames){
    assert.equal(f.frame.length,family==="native"?149*4:96);const json=f.frameJson??JSON.stringify(f.frame);assert.equal(hash(json),f.frameHash);
    const fromText=new Float32Array(JSON.parse(json)),observed=new Float32Array(f.frame);
    assert.deepEqual(Buffer.from(fromText.buffer),Buffer.from(observed.buffer),"actual uniform f32 bytes differ from hashed frame text");
    if(family==="native"){assert.equal(f.frame[39],1);assert.equal(f.frame[47],f.scenario==="zero"?0:2);assert.deepEqual(f.frame.slice(52,55),[0,0,0]);assert.equal(f.frame[56],1);}
    else{assert.equal(f.frame[67],1);assert.equal(f.frame[79],1);assert.equal(f.frame[87],0);}
  }
  return {passed:true,family,actualPacketHash:host.actualPacketHash,sourceHash:host.sourceHash,actualFrames:host.frames.length,actualProbeUploads:host.probeInputs.length};
}
/** Adjacent representable endpoints for format conversion without an RTNE-only assumption.
 * WGSL 15.7.6 permits either adjacent value; D3D11 format conversion specifies RTZ.
 * Attachment behavior is separately witnessed by the fixed passthrough GPU probe.
 * This B5-local enclosure leaves the existing shadow midpoint contract unchanged.
 */
export function probeHalfStorageInterval(value){
  const [lo,hi]=halfFloatInterval(value);
  return [Math.max(0,2*lo-value),2*hi-value];
}
/** Recover irradiance from distinct production HDR formulas using binary16 format endpoints.
 * Each side receives the fixed gamma16 f32 arithmetic budget; no measured-fit tolerance.
 */
export function compareProbeSamplingIntervals(plan,native,web,nativeGain,webGain){
  let intervalsCompared=0;const gamma=16*2**-23/(1-16*2**-23);
  for(const c of plan.cameras)for(const s of plan.fixture.scenarios)for(let round=0;round<2;round++){
    const a=native.frames.find(f=>f.cameraId===c.id&&f.scenario===s.id&&f.round===round),b=web.frames.find(f=>f.cameraId===c.id&&f.scenario===s.id&&f.round===round);assert(a&&b);
    for(const [i,p] of c.points.entries())for(let k=0;k<3;k++){
      assert(p.base[k]>0);const recover=(value,gain)=>{const [lo,hi]=probeHalfStorageInterval(value),scale=p.base[k]*gain;return [lo/(scale*(1+gamma)),hi/(scale*(1-gamma))];};
      const ia=recover(a.samples[i].hdr[k],nativeGain),ib=recover(b.samples[i].hdr[k],webGain);
      assert(Math.max(ia[0],ib[0])<=Math.min(ia[1],ib[1]),`actual recovered sampling interval disagreement ${c.id}/${s.id}/${p.pixel}/${k}`);
      assert(s.irradiance[k]>=ia[0]&&s.irradiance[k]<=ia[1]&&s.irradiance[k]>=ib[0]&&s.irradiance[k]<=ib[1],`uniform sampled irradiance escapes independently bounded half interval ${c.id}/${s.id}/${p.pixel}/${k}: expected=${s.irradiance[k]}, native=${ia}, web=${ib}, HDR=${a.samples[i].hdr[k]}/${b.samples[i].hdr[k]}`);intervalsCompared++;
    }
  }
  return {passed:true,intervalsCompared,arithmeticRelativeBudget:gamma,storageBudget:"binary16 adjacent representable endpoints (RTNE/RTZ admitted)",scope:"recovered uniform irradiance; distinct host HDR, binary16 format conversion plus fixed gamma16 f32 budget"};
}
