import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {validateProbeAnisoIdentity,validateProbeAnisoEvidence} from "./j2ProbeAnisoIdentity.mjs";
const hash=v=>createHash("sha256").update(v).digest("hex");
const fixture={origin:[-16,-16,-15],spacing:16,normalBiasCells:.2,absoluteTolerance:.001};
const fixtureText=JSON.stringify(fixture);
function nativeInputs(){
  const Z_RAMP=[[.25,.5,1],[.5,1,2],[1,2,4]],CHECKER_EVEN=[.25,.5,1],CHECKER_ODD=[1,2,4];
  const cellRgb=(cell,scenario)=>scenario==="zero"?[0,0,0]:scenario==="z-ramp"?Z_RAMP[cell[2]]:(cell[0]+cell[1]+cell[2])%2===0?CHECKER_EVEN:CHECKER_ODD;
  return ["zero","z-ramp","checker"].map(scenario=>{
    const bytes=Buffer.alloc(28*96);
    for(let k=0;k<3;k++){bytes.writeFloatLE(fixture.origin[k],k*4);bytes.writeFloatLE(3,16+k*4);bytes.writeFloatLE(fixture.origin[k]+3*fixture.spacing,32+k*4);}bytes.writeFloatLE(16,12);bytes.writeFloatLE(1,28);bytes.writeFloatLE(27,44);
    for(let p=0;p<27;p++){const rgb=cellRgb([p%3,Math.floor(p/3)%3,Math.floor(p/9)],scenario);rgb.forEach((v,k)=>bytes.writeFloatLE(v,(p+1)*96+k*4));bytes.writeFloatLE(1,(p+1)*96+12);bytes.writeFloatLE(100000,(p+1)*96+16);bytes.writeFloatLE(1,(p+1)*96+20);}
    return {id:scenario,packedBytes:Array.from(bytes),packedHash:hash(bytes)};
  });
}
test("aniso uploaded per-cell bytes, packet and frame are authoritative",()=>{
  const packet={materials:[{id:"surface",metallic:0,roughness:.8}]};
  const frame=Array(596).fill(0);frame[39]=1;frame[47]=2;frame[56]=1;
  const host={actualPacket:packet,actualPacketJson:JSON.stringify(packet),actualPacketHash:hash(JSON.stringify(packet)),sourceHash:"f".repeat(64),sourceAssembly:{factory:"native_mesh_wgsl::native_mesh_shader_source",vertex:"vertex_main",fragment:"fragment_main"},probeInputs:nativeInputs(),frames:[{scenario:"z-ramp",frame,frameJson:JSON.stringify(frame),frameHash:hash(JSON.stringify(frame))}]};
  assert(validateProbeAnisoIdentity(host,"native",packet,fixture).passed);
  const zeroFrame=Array(596).fill(0);zeroFrame[39]=1;zeroFrame[47]=0;zeroFrame[56]=1;
  const zero={...host,frames:[{scenario:"zero",frame:zeroFrame,frameJson:JSON.stringify(zeroFrame),frameHash:hash(JSON.stringify(zeroFrame))}]};
  assert(validateProbeAnisoIdentity(zero,"native",packet,fixture).passed);
  // Wrong origin in the native header must fail.
  const wrongOrigin=structuredClone(host);const bytes=Buffer.from(wrongOrigin.probeInputs[1].packedBytes);bytes.writeFloatLE(-16,8);wrongOrigin.probeInputs[1].packedBytes=Array.from(bytes);wrongOrigin.probeInputs[1].packedHash=hash(bytes);
  assert.throws(()=>validateProbeAnisoIdentity(wrongOrigin,"native",packet,fixture));
  // Wrong upload hash without touching bytes must fail.
  const wrongHash=structuredClone(host);wrongHash.probeInputs[1].packedHash="0".repeat(64);
  assert.throws(()=>validateProbeAnisoIdentity(wrongHash,"native",packet,fixture));
  // A per-cell RGB drift (z-ramp layer 2 replaced by layer 1) must fail.
  const drifted=structuredClone(host);const dbytes=Buffer.from(drifted.probeInputs[1].packedBytes);
  for(let p=18;p<27;p++){[0.5,1,2].forEach((v,k)=>dbytes.writeFloatLE(v,(p+1)*96+k*4));}drifted.probeInputs[1].packedBytes=Array.from(dbytes);drifted.probeInputs[1].packedHash=hash(dbytes);
  assert.throws(()=>validateProbeAnisoIdentity(drifted,"native",packet,fixture));
  // Zero scenario must keep GI disabled (mode 0), any non-zero mode must fail.
  const enabledZero=structuredClone(zero);enabledZero.frames[0].frame[47]=2;enabledZero.frames[0].frameHash=hash(JSON.stringify(enabledZero.frames[0].frame));
  assert.throws(()=>validateProbeAnisoIdentity(enabledZero,"native",packet,fixture));
});
test("web half lanes and metadata are frozen per cell",()=>{
  const packet={materials:[{id:"surface",metallic:0,roughness:.8}]};
  const HALF={0:0,0.25:0x3400,0.5:0x3800,1:0x3c00,2:0x4000,4:0x4400};
  const Z_RAMP=[[.25,.5,1],[.5,1,2],[1,2,4]],CHECKER_EVEN=[.25,.5,1],CHECKER_ODD=[1,2,4];
  const cellRgb=cell=>scenario=>scenario==="zero"?[0,0,0]:scenario==="z-ramp"?Z_RAMP[cell[2]]:(cell[0]+cell[1]+cell[2])%2===0?CHECKER_EVEN:CHECKER_ODD;
  const metadata=new Uint8Array(256),view=new DataView(metadata.buffer);
  for(let k=0;k<3;k++){view.setFloat32(k*4,fixture.origin[k],true);view.setUint32(16+k*4,3,true);view.setFloat32(48+k*4,fixture.origin[k]+2*fixture.spacing,true);}view.setFloat32(12,16,true);view.setUint32(60,27,true);
  const inputs=["zero","z-ramp","checker"].map(scenario=>{
    const texels=Array.from({length:27},(_,p)=>{const rgb=cellRgb([p%3,Math.floor(p/3)%3,Math.floor(p/9)])(scenario);return [HALF[rgb[0]],HALF[rgb[1]],HALF[rgb[2]],0x3c00];}).flat();
    return {id:scenario,textureHalfBits:texels,textureHash:hash(texels.join(",")),metadataBytes:Array.from(metadata),metadataHash:hash(Array.from(metadata).join(","))};
  });
  const frame=Array(96).fill(0);frame[67]=1;frame[79]=1;frame[87]=0;
  const host={actualPacket:packet,actualPacketJson:JSON.stringify(packet),actualPacketHash:hash(JSON.stringify(packet)),sourceHash:"e".repeat(64),sourceAssembly:{factory:"pipelines.ts moduleCode",deformation:false,textureArrays:false,layeredMaterials:false,vertex:"vertexMain",fragment:"fragmentMain",compileRecords:[{label:"Deep forward PBR plain/depth/ccw",failed:false}]},probeInputs:inputs,frames:[{scenario:"checker",frame,frameJson:JSON.stringify(frame),frameHash:hash(JSON.stringify(frame))}]};
  assert(validateProbeAnisoIdentity(host,"web",packet,fixture,"e".repeat(64)).passed);
  const badLayer=structuredClone(host);badLayer.probeInputs[1].textureHalfBits[18*4]=0x3800;
  assert.throws(()=>validateProbeAnisoIdentity(badLayer,"web",packet,fixture,"e".repeat(64)));
  // Regression for the 2026-10-01 GPU first-run break: fp16 0x4200 decodes to 3.0, so a blue
  // lane carrying it in place of the frozen 4.0 (0x4400) must fail identity.
  const badBlue=structuredClone(host);badBlue.probeInputs[1].textureHalfBits[18*4+2]=0x4200;
  assert.throws(()=>validateProbeAnisoIdentity(badBlue,"web",packet,fixture,"e".repeat(64)));
  const badShader=structuredClone(host);badShader.sourceHash="d".repeat(64);
  assert.throws(()=>validateProbeAnisoIdentity(badShader,"web",packet,fixture,"e".repeat(64)));
});
test("evidence freshness rejects stale profile, wrong gate and drifted sources",()=>{
  const evidence={inputHash:{profileHash:hash(fixtureText),sourceIdentity:{"a.ts":"1","b.rs":"2"}},frozen:{origin:[-16,-16,-15],spacing:16,normalBiasCells:.2,absoluteTolerance:.001}};
  assert(validateProbeAnisoEvidence(evidence,fixtureText,{"a.ts":"1","b.rs":"2"}).passed);
  assert.throws(()=>validateProbeAnisoEvidence(evidence,JSON.stringify({...fixture,origin:[-16,-16,-16]}),{"a.ts":"1","b.rs":"2"}),"stale profile must fail");
  assert.throws(()=>validateProbeAnisoEvidence({...evidence,frozen:{...evidence.frozen,absoluteTolerance:.01}},fixtureText,{"a.ts":"1","b.rs":"2"}),"wrong gate must fail");
  assert.throws(()=>validateProbeAnisoEvidence(evidence,fixtureText,{"a.ts":"9","b.rs":"2"}),"drifted source must fail");
  assert.throws(()=>validateProbeAnisoEvidence(evidence,fixtureText,{"a.ts":"1","b.rs":"2","c.rs":"3"}),"grown source set must fail");
});
