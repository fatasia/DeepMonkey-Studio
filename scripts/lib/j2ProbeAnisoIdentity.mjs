import assert from "node:assert/strict";
import {createHash} from "node:crypto";
const hash=v=>createHash("sha256").update(v).digest("hex");
const stable=v=>JSON.stringify(v&&typeof v==="object"?Array.isArray(v)?v.map(x=>JSON.parse(stable(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(stable(v[k]))])):v);
// Independent reconciliation copy of the frozen scenario values (deliberately not imported from
// the fixture so a fixture edit breaks identity instead of silently following it).
const Z_RAMP=[[.25,.5,1],[.5,1,2],[1,2,4]],CHECKER_EVEN=[.25,.5,1],CHECKER_ODD=[1,2,4];
function anisoCellIrradiance(cell,scenario){
  if(scenario==="zero")return [0,0,0];
  if(scenario==="z-ramp")return Z_RAMP[cell[2]];
  return (cell[0]+cell[1]+cell[2])%2===0?CHECKER_EVEN:CHECKER_ODD;
}
const anisoCell=linear=>[linear%3,Math.floor(linear/3)%3,Math.floor(linear/9)];
const HALF={0:0,0.25:0x3400,0.5:0x3800,1:0x3c00,2:0x4000,4:0x4400};
// Independent fp16 round-trip guard (this file deliberately does not import the fixture, so the
// guard is a second copy of the check, not the same code path): 0x4200 is fp16 3.0, not the
// frozen 4.0 - that mis-encoding was the 2026-10-01 GPU first-run break. Module level so the
// runner fails before any browser/GPU work instead of uploading wrong lanes.
const decodeFrozenHalf=bits=>{const exponent=(bits>>>10)&31,fraction=bits&1023;
  return exponent===0?fraction/1024*2**-14:2**(exponent-15)*(1+fraction/1024);};
for(const [value,bits] of Object.entries(HALF))if(decodeFrozenHalf(bits)!==Number(value))
  throw Error(`aniso frozen half-bit table mis-encodes ${value} as 0x${bits.toString(16)} (decodes ${decodeFrozenHalf(bits)})`);
export function validateProbeAnisoIdentity(host,family,expectedPacket,fixture,webShaderHash){
  assert.equal(hash(host.actualPacketJson),host.actualPacketHash,"actual submitted packet hash");
  assert.equal(stable(JSON.parse(host.actualPacketJson)),stable(host.actualPacket),"packet text matches observed packet");
  assert.equal(stable(host.actualPacket),stable(expectedPacket),"actual submitted material mutations differ from frozen oracle");
  if(family==="web"){
    assert.equal(host.sourceHash,webShaderHash,"actual ordinary stock shader identity");
    const s=host.sourceAssembly;assert.equal(s.factory,"pipelines.ts moduleCode");assert.equal(s.deformation,false);assert.equal(s.textureArrays,false);assert.equal(s.layeredMaterials,false);
    assert.equal(s.vertex,"vertexMain");assert.equal(s.fragment,"fragmentMain");assert(s.compileRecords.some(r=>r.label==="Deep forward PBR plain/depth/ccw"&&!r.failed));
  }else{assert.equal(host.sourceAssembly.factory,"native_mesh_wgsl::native_mesh_shader_source");assert.equal(host.sourceAssembly.vertex,"vertex_main");assert.equal(host.sourceAssembly.fragment,"fragment_main");}
  assert.equal(host.probeInputs.length,3);
  const scenarios=["zero","z-ramp","checker"];
  for(const scenario of scenarios){const input=host.probeInputs.find(v=>v.id===scenario);assert(input,"complete aniso profiles");
    if(family==="native"){
      const bytes=Buffer.from(input.packedBytes);assert.equal(bytes.length,28*96);assert.equal(hash(bytes),input.packedHash);
      for(let k=0;k<3;k++){assert.equal(bytes.readFloatLE(k*4),fixture.origin[k]);assert.equal(bytes.readFloatLE(16+k*4),3);assert.equal(bytes.readFloatLE(32+k*4),fixture.origin[k]+3*fixture.spacing);}
      assert.equal(bytes.readFloatLE(12),fixture.spacing);assert.equal(bytes.readFloatLE(28),1);assert.equal(bytes.readFloatLE(44),27);
      for(let p=0;p<27;p++){const rgb=anisoCellIrradiance(anisoCell(p),scenario);for(let k=0;k<3;k++)assert.equal(bytes.readFloatLE((p+1)*96+k*4),rgb[k]);
        assert.equal(bytes.readFloatLE((p+1)*96+12),1);assert.equal(bytes.readFloatLE((p+1)*96+16),100000);assert.equal(bytes.readFloatLE((p+1)*96+20),1);for(let k=6;k<24;k++)assert.equal(bytes.readFloatLE((p+1)*96+k*4),0);}
    }else{
      assert.equal(input.textureHalfBits.length,27*4);assert.equal(hash(input.textureHalfBits.join(",")),input.textureHash);assert.equal(input.metadataBytes.length,256);assert.equal(hash(input.metadataBytes.join(",")),input.metadataHash);
      for(let p=0;p<27;p++){const rgb=anisoCellIrradiance(anisoCell(p),scenario);assert.deepEqual(input.textureHalfBits.slice(p*4,p*4+4),[HALF[rgb[0]],HALF[rgb[1]],HALF[rgb[2]],0x3c00]);}
      const bytes=Buffer.from(input.metadataBytes);for(let k=0;k<3;k++){assert.equal(bytes.readFloatLE(k*4),fixture.origin[k]);assert.equal(bytes.readUInt32LE(16+k*4),3);assert.equal(bytes.readFloatLE(48+k*4),fixture.origin[k]+2*fixture.spacing);}assert.equal(bytes.readFloatLE(12),fixture.spacing);assert.equal(bytes.readUInt32LE(60),27);assert(bytes.subarray(64).every(v=>v===0));
    }
  }
  for(const f of host.frames){
    assert.equal(f.frame.length,family==="native"?149*4:96);const json=f.frameJson??JSON.stringify(f.frame);assert.equal(hash(json),f.frameHash);
    const fromText=new Float32Array(JSON.parse(json)),observed=new Float32Array(f.frame);
    assert.deepEqual(Buffer.from(fromText.buffer),Buffer.from(observed.buffer),"actual aniso f32 bytes differ from hashed frame text");
    if(family==="native"){assert.equal(f.frame[39],1);assert.equal(f.frame[47],f.scenario==="zero"?0:2);assert.deepEqual(f.frame.slice(52,55),[0,0,0]);assert.equal(f.frame[56],1);}
    else{assert.equal(f.frame[67],1);assert.equal(f.frame[79],1);assert.equal(f.frame[87],0);}
  }
  return {passed:true,family,actualPacketHash:host.actualPacketHash,sourceHash:host.sourceHash,actualFrames:host.frames.length,actualProbeUploads:host.probeInputs.length};
}
/** Evidence freshness: input hashes plus the frozen gate fields must match the live repository
 * before any comparison runs; stale evidence is rejected instead of silently compared. */
export function validateProbeAnisoEvidence(evidence,fixtureText,currentSourceIdentity){
  const fixture=JSON.parse(fixtureText);
  assert.equal(evidence.inputHash.profileHash,hash(fixtureText),"aniso evidence profile hash is stale");
  for(const [file,digest] of Object.entries(currentSourceIdentity))assert.equal(evidence.inputHash.sourceIdentity[file],digest,`aniso evidence source identity stale for ${file}`);
  assert.equal(evidence.frozen.origin.length,3);
  for(let k=0;k<3;k++)assert.equal(evidence.frozen.origin[k],fixture.origin[k],"aniso evidence origin is stale");
  assert.equal(evidence.frozen.spacing,fixture.spacing,"aniso evidence spacing is stale");
  assert.equal(evidence.frozen.absoluteTolerance,fixture.absoluteTolerance,"aniso evidence tolerance gate is stale");
  assert.equal(evidence.frozen.normalBiasCells,fixture.normalBiasCells,"aniso evidence bias is stale");
  return {passed:true,profileHash:evidence.inputHash.profileHash,sourceFiles:Object.keys(currentSourceIdentity).length};
}
