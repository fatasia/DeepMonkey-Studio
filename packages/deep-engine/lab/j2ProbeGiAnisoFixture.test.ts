import {describe,it,expect} from "vitest";
import {probeAnisoGain,HANDOVER_ADMISSION,probeAnisoWeight,buildProbeAnisoPlan,compareProbeAniso,
  expectedProbeAnisoHdr,anisoCellIrradiance,anisoStorageSample,anisoTextureSample,anisoTextureHalfLanes,type ProbeAnisoFixture} from "./j2ProbeGiAnisoFixture.js";
import {readFileSync} from "node:fs";
import fixture from "../fixtures/j2-probe-gi-aniso-v1.json";

describe("anisotropic probe follow-up CPU contracts",()=>{
  const f=fixture as unknown as ProbeAnisoFixture;
  const source=JSON.parse(readFileSync(new URL("../../deep-engine-native/tests/fixtures/runtime-package-v1.json",import.meta.url),"utf8"));
  const manifest=JSON.parse(readFileSync(new URL("../fixtures/j3-hdr-flat-normal-v1.json",import.meta.url),"utf8"));

  it("retains positive distinct host gains and frozen half-exact scenario values",()=>{
    expect(probeAnisoGain("native",f)).toBeCloseTo(1/Math.PI,12);
    expect(probeAnisoGain("web",f)).toBeGreaterThan(.9);
    expect(probeAnisoGain("native",f)).not.toEqual(probeAnisoGain("web",f));
    expect(anisoCellIrradiance([0,0,0],"z-ramp",f)).toEqual([0.25,0.5,1]);
    expect(anisoCellIrradiance([1,1,2],"z-ramp",f)).toEqual([1,2,4]);
    expect(anisoCellIrradiance([0,0,0],"checker",f)).toEqual(f.checkerEven);
    expect(anisoCellIrradiance([1,0,0],"checker",f)).toEqual(f.checkerOdd);
    expect(anisoCellIrradiance([2,2,2],"zero",f)).toEqual([0,0,0]);
  });

  it("cross-checks CPU admission against the handover minima on all 85 points",()=>{
    const plan=buildProbeAnisoPlan(source,manifest,f);
    const points=plan.cameras.flatMap(c=>c.points);
    expect(points.length).toBe(85);
    expect(points.every(p=>p.normal.every(v=>v===0)||p.normal[2]===1)).toBe(true);
    let minNative=Infinity,minWeb=Infinity;
    for(const p of points){
      const native=probeAnisoWeight(p.world,p.normal,f,"native"),web=probeAnisoWeight(p.world,p.normal,f,"web");
      expect(native).toBeGreaterThanOrEqual(.001);
      expect(web).toBeGreaterThan(0);
      minNative=Math.min(minNative,native);minWeb=Math.min(minWeb,web);
    }
    expect(Math.abs(minNative-HANDOVER_ADMISSION.native)).toBeLessThan(1e-8);
    expect(Math.abs(minWeb-HANDOVER_ADMISSION.web)).toBeLessThan(1e-8);
    expect(plan.admission.minNative).toBeCloseTo(minNative,15);
    // Original B5 grid-plane origin stays a native-admission negative control (legit family gap).
    for(const p of points){
      expect(probeAnisoWeight(p.world,p.normal,{origin:[-16,-16,-16],spacing:16},"native")).toBeLessThan(.001);
      expect(probeAnisoWeight(p.world,p.normal,{origin:[-16,-16,-16],spacing:16},"web")).toBeGreaterThan(0);
    }
  });

  it("proves z-cell demonstrability and the uniform collapse control",()=>{
    const plan=buildProbeAnisoPlan(source,manifest,f),points=plan.cameras.flatMap(c=>c.points);
    const layer1=f.zRamp[1]!;
    for(const p of points){
      const native=anisoStorageSample(p.world,p.normal,"z-ramp",f),web=anisoTextureSample(p.world,p.normal,"z-ramp",f);
      for(let k=0;k<3;k++){
        expect(Math.abs(native.irradiance[k]!-layer1[k]!)).toBeLessThan(1e-9);
        expect(Math.abs(web.irradiance[k]!-layer1[k]!)).toBeGreaterThan(f.absoluteTolerance);
        expect(web.irradiance[k]!).toBeGreaterThan(layer1[k]!);
      }
      expect(expectedProbeAnisoHdr(p,"z-ramp",f,"native").every(v=>v>0)).toBe(true);
      expect(expectedProbeAnisoHdr(p,"z-ramp",f,"web").every(v=>v>0)).toBe(true);
      const checkerNative=anisoStorageSample(p.world,p.normal,"checker",f).irradiance,checkerWeb=anisoTextureSample(p.world,p.normal,"checker",f).irradiance;
      for(let k=0;k<3;k++)expect(Math.abs(checkerNative[k]!-checkerWeb[k]!)).toBeGreaterThan(f.absoluteTolerance);
      const zeroNative=expectedProbeAnisoHdr(p,"zero",f,"native"),zeroWeb=expectedProbeAnisoHdr(p,"zero",f,"web");
      expect(zeroNative.every(v=>v===0)).toBe(true);
      expect(zeroWeb.every(v=>v===0)).toBe(true);
    }
    const halfLanes=anisoTextureHalfLanes("z-ramp",f);
    expect(halfLanes.slice(0,4)).toEqual([0x3400,0x3800,0x3c00,0x3c00]);
    expect(halfLanes.slice(9*4,9*4+4)).toEqual([0x3800,0x3c00,0x4000,0x3c00]);
    expect(halfLanes.slice(18*4,18*4+4)).toEqual([0x3c00,0x4000,0x4200,0x3c00]);
    expect(halfLanes.length).toBe(27*4);
  });

  it("rejects frozen profile drift and broken host receipts",()=>{
    expect(()=>buildProbeAnisoPlan(source,manifest,{...f,origin:[-16,-16,-16]})).toThrow("frozen profile changed");
    expect(()=>buildProbeAnisoPlan(source,manifest,{...f,absoluteTolerance:.01})).toThrow("frozen profile changed");
    expect(()=>buildProbeAnisoPlan(source,manifest,{...f,zRamp:[[0,0,0],[1,1,1]]})).toThrow("frozen profile changed");
    const plan=buildProbeAnisoPlan(source,manifest,f);
    const points=plan.cameras.flatMap(c=>c.points);
    const perfectHost=(family:"native"|"web")=>({passed:true,packageHash:plan.packageHash,packetHash:plan.packetHash,sourceHash:"f".repeat(64),errors:[],
      frames:plan.cameras.flatMap(c=>[...["zero","z-ramp","checker"] as const].flatMap(scenario=>[0,1].map(round=>({cameraId:c.id,scenario,round,vp:Array.from(c.expectedVP),rgbaHash:"f".repeat(64),
        samples:c.points.map(p=>({pixel:p.pixel,hdr:[...expectedProbeAnisoHdr(p,scenario,f,family),1]}))}))))});
    expect(compareProbeAniso(plan,perfectHost("web"),"web").pointsCompared).toBe(510);
    expect(compareProbeAniso(plan,perfectHost("native"),"native").pointsCompared).toBe(510);
    const missing=structuredClone(perfectHost("web"));missing.frames[0]!.samples.pop();
    expect(()=>compareProbeAniso(plan,missing,"web")).toThrow();
    const stale=structuredClone(perfectHost("web"));stale.sourceHash="";
    expect(()=>compareProbeAniso(plan,stale,"web")).toThrow();
    const dark=structuredClone(perfectHost("web"));
    const frame=dark.frames.find(v=>v.scenario==="z-ramp")!;frame.samples[0]!.hdr[0]=0;
    expect(()=>compareProbeAniso(plan,dark,"web")).toThrow();
    const alpha=structuredClone(perfectHost("web"));alpha.frames[0]!.samples[0]!.hdr[3]=0;
    expect(()=>compareProbeAniso(plan,alpha,"web")).toThrow();
  });
});
