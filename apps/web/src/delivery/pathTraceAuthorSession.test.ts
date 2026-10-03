import {describe,expect,it} from "vitest";
import {createHash} from "node:crypto";
import type {SceneSnapshot,PrimitiveState} from "@bim-studio/contracts";
import { decodeRadianceHdr } from "@bim-studio/deep-engine/textures";
import {preparePathTraceAuthor,pathTraceAuthorSourceHash} from "./pathTraceAuthorPreparation";
import {PathTraceAuthorSession} from "./pathTraceAuthorSession";
import {DEFAULT_ENVIRONMENT,DEFAULT_LIGHTING} from "../appDefaults";
function scene():SceneSnapshot {
  const sphere:PrimitiveState={modelId:"sphere",name:"PBR sphere",kind:"sphere",visible:true,opacity:1,color:"#b09060",
    transform:{position:{x:1e9,y:0,z:0},rotation:{x:.2,y:.3,z:.4},scale:{x:1.3,y:.8,z:1}},
    material:{doubleSided:true,roughness:1,metalness:.5,ior:1.5}};
  return {schemaVersion:1,id:"author",projectId:"p",name:"PT authored",models:[],primitives:[sphere],measurements:[],
    camera:{mode:"orbit",position:{x:1e9,y:0,z:3},target:{x:1e9,y:0,z:0}},createdAt:"",updatedAt:"",
    environment:structuredClone(DEFAULT_ENVIRONMENT),lighting:structuredClone(DEFAULT_LIGHTING),weather:"sunny"};
}
const config={width:2,height:2,maxSamples:65536,minSamples:64,varianceThreshold:.02,maxAccumulationBytes:96,sampleSeed:19};
const options={loadModel:async()=>new Uint8Array()};
describe("actual author compiler -> physical lighting -> async session/HDR",()=>{
  it("consumes real default direction/studio, preserves source and exports linear HDR with physical receipt",async()=>{
    const source=scene(),before=structuredClone(source),prepared=await preparePathTraceAuthor(source,config,"physical-scene-radiance",options);
    expect(source).toEqual(before);expect(prepared.camera.position).toEqual([0,0,3]);
    expect(prepared.lighting!.radiance).toEqual([2.2,2.2,2.2]);expect(prepared.studioIntensity).toBe(1);
    expect(prepared.inapplicableRealtimeControls.realtimeGiEnhancement).toBe(.32);
    expect(prepared.packet.instances.some(i=>i.id.startsWith("scene.auxiliary-grid"))).toBe(false);
    const session=new PathTraceAuthorSession(prepared);let progress=0;
    await session.accumulate(new AbortController().signal,async()=>{},()=>{progress++;});
    const n=session.render.session.sampleCount,noise=session.render.maxRelativeStandardError;
    console.info("physical noise",{n,noise,global:session.render.session.converged});
    expect(n).toBeGreaterThanOrEqual(64);expect(progress).toBe(n);expect(session.render.converged).toBe(true);
    const output=session.export(false,pathTraceAuthorSourceHash(source)),image=decodeRadianceHdr(output.bytes);
    expect(output.receipt.preview).toBe(false);expect(output.receipt.eligibleFinal).toBe(true);
    expect(output.receipt.illumination).toBe("physical-scene-radiance");expect(output.receipt.sessionReceipt).toBeDefined();
    expect(image.data.every(v=>Number.isFinite(v)&&v>=0)).toBe(true);expect(session.render.session.residentBytes).toBe(0);
    const sha=createHash("sha256").update(output.bytes).digest("hex");
    console.info("I16 physical author HDR",{samples:n,noise,sha,pixels:[...image.data]});
    session.dispose();
  });
  it("does not multiply physical radiance by realtime GI enhancement",async()=>{
    const a=scene(),b=scene();b.lighting!.globalIlluminationIntensity=9;
    const pa=await preparePathTraceAuthor(a,config,"physical-scene-radiance",options),pb=await preparePathTraceAuthor(b,config,"physical-scene-radiance",options);
    const sa=new PathTraceAuthorSession(pa),sb=new PathTraceAuthorSession(pb);
    sa.render.advance(128);sb.render.advance(128);expect(sa.render.image()).toEqual(sb.render.image());sa.dispose();sb.dispose();
  });
  it("makes reference illumination explicit and keeps author unsupported lighting fail closed",async()=>{
    const source=scene();source.environment!.environmentMapUrl="actual.hdr";
    await expect(preparePathTraceAuthor(source,config,"physical-scene-radiance",options)).rejects.toThrow(/HDR/);
    const directional=await preparePathTraceAuthor(source,config,"directional-reference",options);
    expect(directional.studioIntensity).toBe(0);expect(directional.lighting).toBeDefined();
    const white=await preparePathTraceAuthor(source,config,"white-furnace-reference",options);
    expect(white.studioIntensity).toBe(0);expect(white.lighting).toBeUndefined();
    source.lighting!.lights!.push({...source.lighting!.lights![0]!,id:"extra",type:"point"});
    await expect(preparePathTraceAuthor(source,config,"directional-reference",options)).rejects.toThrow(/局部光/);
  });
  it("releases real accumulation on async abort and rejects old material/camera snapshots before HDR",async()=>{
    const source=scene(),prepared=await preparePathTraceAuthor(source,config,"physical-scene-radiance",options);
    const cancelled=new PathTraceAuthorSession(prepared),abort=new AbortController();
    await expect(cancelled.accumulate(abort.signal,async()=>abort.abort(),()=>{})).rejects.toThrow();
    expect(cancelled.render.session.residentBytes).toBe(0);expect(()=>cancelled.export(true,prepared.sourceHash)).toThrow();
    const stale=new PathTraceAuthorSession(prepared);stale.render.advance(2);source.primitives[0]!.material!.roughness=.7;
    expect(()=>stale.export(true,pathTraceAuthorSourceHash(source))).toThrow(/场景已修改/);
    expect(stale.render.session.residentBytes).toBe(0);cancelled.dispose();stale.dispose();
  });
  it("keeps failed noise gate preview-only and preserves batch replay",async()=>{
    const source=scene(),prepared=await preparePathTraceAuthor(source,{...config,maxSamples:2,minSamples:2,varianceThreshold:1e-12},"physical-scene-radiance",options);
    const a=new PathTraceAuthorSession(prepared),b=new PathTraceAuthorSession(prepared);
    a.render.advance(2);await b.render.advanceAsync(2,async()=>{});expect(a.render.image()).toEqual(b.render.image());
    expect(()=>a.export(false,prepared.sourceHash)).toThrow(/convergence/);
    const output=a.export(true,prepared.sourceHash);expect(output.receipt.preview).toBe(true);expect(output.receipt.eligibleFinal).toBe(false);
    expect(output.receipt.sessionReceipt).toBeUndefined();expect(decodeRadianceHdr(output.bytes).width).toBe(2);a.dispose();b.dispose();
  });
});
