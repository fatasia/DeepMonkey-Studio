import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {validateProbeActualIdentity,compareProbeSamplingIntervals,probeHalfStorageInterval} from "./j2ProbeGiActualIdentity.mjs";
const hash=v=>createHash("sha256").update(v).digest("hex");
test("actual uploaded bytes, material packet and frame are authoritative",()=>{
  const packet={materials:[{id:"surface",metallic:0,roughness:.8}]},fixture={origin:[-16,-16,-16],spacing:16,scenarios:[{id:"zero",irradiance:[0,0,0]},{id:"uniform-a",irradiance:[.25,.5,1]},{id:"uniform-b",irradiance:[.5,1,2]}]};
  const inputs=fixture.scenarios.map(s=>{const bytes=Buffer.alloc(28*96);for(let k=0;k<3;k++){bytes.writeFloatLE(-16,k*4);bytes.writeFloatLE(3,16+k*4);bytes.writeFloatLE(32,32+k*4);}bytes.writeFloatLE(16,12);bytes.writeFloatLE(1,28);bytes.writeFloatLE(27,44);for(let p=1;p<=27;p++){s.irradiance.forEach((v,k)=>bytes.writeFloatLE(v,p*96+k*4));bytes.writeFloatLE(1,p*96+12);bytes.writeFloatLE(100000,p*96+16);bytes.writeFloatLE(1,p*96+20);}return {id:s.id,packedBytes:Array.from(bytes),packedHash:hash(bytes)};});
  const frame=Array(596).fill(0);frame[0]=Math.fround(1.8304877);frame[39]=1;frame[47]=2;frame[56]=1;
  const host={actualPacket:packet,actualPacketJson:JSON.stringify(packet),actualPacketHash:hash(JSON.stringify(packet)),sourceHash:"f".repeat(64),sourceAssembly:{factory:"native_mesh_wgsl::native_mesh_shader_source",vertex:"vertex_main",fragment:"fragment_main"},probeInputs:inputs,frames:[{scenario:"uniform-a",frame,frameJson:JSON.stringify(frame),frameHash:hash(JSON.stringify(frame))}]};
  assert(validateProbeActualIdentity(host,"native",packet,fixture).passed);
  const text32=structuredClone(host);text32.frames[0].frameJson=JSON.stringify(frame).replace(String(frame[0]),"1.8304877");text32.frames[0].frameHash=hash(text32.frames[0].frameJson);assert(validateProbeActualIdentity(text32,"native",packet,fixture).passed);
  const wrongBits=structuredClone(text32);wrongBits.frames[0].frame[0]=Math.fround(1.8304877+1e-6);assert.throws(()=>validateProbeActualIdentity(wrongBits,"native",packet,fixture));
  const upload=structuredClone(host);upload.probeInputs[1].packedBytes[110]^=1;assert.throws(()=>validateProbeActualIdentity(upload,"native",packet,fixture));
  const mutated=structuredClone(host);mutated.actualPacket.materials[0].metallic=1;assert.throws(()=>validateProbeActualIdentity(mutated,"native",packet,fixture));
  const disabled=structuredClone(host);disabled.frames[0].frame[47]=0;assert.throws(()=>validateProbeActualIdentity(disabled,"native",packet,fixture));
});
test("distinct HDR formulas recover common uniform sampling inside independently derived half cells",()=>{
  const nativeGain=1/Math.PI,webGain=1-(.04*.75+.0625)*(1+.04*(1/.8125-1));
  const plan={cameras:[{id:"camera",points:[{pixel:0,base:[1,1,1]}]}],fixture:{scenarios:[{id:"uniform-a",irradiance:[.25,.25,.25]}]}};
  const host=value=>({frames:[0,1].map(round=>({cameraId:"camera",scenario:"uniform-a",round,samples:[{hdr:[value,value,value,1]}]}))});
  const native=host(.07958984375),web=host(.2266845703125);
  assert.equal(compareProbeSamplingIntervals(plan,native,web,nativeGain,webGain).intervalsCompared,6);
  assert.throws(()=>compareProbeSamplingIntervals(plan,native,host(.25),nativeGain,webGain));
});
test("storage conversion endpoints admit adjacent rounding and reject farther bins",()=>{
  assert.deepEqual(probeHalfStorageInterval(1),[1-2**-11,1+2**-10]);
  assert.deepEqual(probeHalfStorageInterval(0),[0,2**-24]);
  assert.deepEqual(probeHalfStorageInterval(2**-24),[0,2*2**-24]);
  const expected=Math.fround(.86*.25*(1-(.04*.75+.0625)*(1+.04*(1/.8125-1))));
  const [lo,hi]=probeHalfStorageInterval(.19482421875);
  assert(expected>lo&&expected<hi);
  assert(expected>probeHalfStorageInterval(.194580078125)[1]);
  assert.throws(()=>probeHalfStorageInterval(.1949));
  assert.throws(()=>probeHalfStorageInterval(-1));
});
