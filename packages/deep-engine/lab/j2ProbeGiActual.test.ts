import {describe,it,expect} from "vitest";
import {probeGiGain,blackProbeIbl,buildProbeActualPlan,compareProbeActual,probeActualWeight,type ProbeActualFixture} from "./j2ProbeGiActual.js";
import {readFileSync} from "node:fs";
import fixture from "../fixtures/j2-probe-gi-actual-v1.json";
describe("production GI host mixing contracts",()=>{
  const f=fixture as unknown as ProbeActualFixture;
  it("retains positive distinct host gains for nonmetal surfaces",()=>{expect(probeGiGain("native",f)).toBeCloseTo(1/Math.PI,12);expect(probeGiGain("web",f)).toBeGreaterThan(.9);expect(probeGiGain("native",f)).not.toEqual(probeGiGain("web",f));});
  it("uploads exact legal black environment and constant independent DFG",()=>{const ibl=blackProbeIbl(f),bits=new Uint16Array(Uint8Array.from(atob(ibl.brdfLut.dataBase64),v=>v.charCodeAt(0)).buffer);expect(Array.from(bits)).toEqual([0x3a00,0x2c00,0,0x3c00]);expect(atob(ibl.diffuse.mips[0]!.dataBase64).length).toBe(48);});
  it("rejects missing original points, absent GI, alpha and source identity",()=>{
    const source=JSON.parse(readFileSync(new URL("../../deep-engine-native/tests/fixtures/runtime-package-v1.json",import.meta.url),"utf8"));
    const manifest=JSON.parse(readFileSync(new URL("../fixtures/j3-hdr-flat-normal-v1.json",import.meta.url),"utf8")),plan=buildProbeActualPlan(source,manifest,f);
    const gridPlane={...f,origin:[-16,-16,-16] as const};
    expect(()=>buildProbeActualPlan(source,manifest,gridPlane)).toThrow("rejected 85/85");
    for(const p of plan.cameras.flatMap(c=>c.points)){
      expect(probeActualWeight(p.world,p.normal,gridPlane,"native")).toBeLessThan(.001);
      expect(probeActualWeight(p.world,p.normal,gridPlane,"web")).toBeGreaterThan(0);
      expect(probeActualWeight(p.world,p.normal,f,"native")).toBeGreaterThanOrEqual(.001);
      expect(probeActualWeight(p.world,p.normal,f,"web")).toBeGreaterThan(0);
    }
    const host={passed:true,packageHash:plan.packageHash,packetHash:plan.packetHash,sourceHash:"f".repeat(64),errors:[],frames:plan.cameras.flatMap(c=>f.scenarios.flatMap(s=>[0,1].map(round=>({cameraId:c.id,scenario:s.id,round,vp:Array.from(c.expectedVP),rgbaHash:"f".repeat(64),samples:c.points.map(p=>({pixel:p.pixel,hdr:[...p.base.map((b,k)=>b*s.irradiance[k]!*probeGiGain("web",f)),1]}))}))))};
    expect(compareProbeActual(plan,host,"web").pointsCompared).toBe(510);
    const missing=structuredClone(host);missing.frames[0]!.samples.pop();expect(()=>compareProbeActual(plan,missing,"web")).toThrow();
    const absent=structuredClone(host);absent.frames.find(v=>v.scenario==="uniform-a")!.samples[0]!.hdr[0]=0;expect(()=>compareProbeActual(plan,absent,"web")).toThrow();
    const alpha=structuredClone(host);alpha.frames[0]!.samples[0]!.hdr[3]=0;expect(()=>compareProbeActual(plan,alpha,"web")).toThrow();
    const identity=structuredClone(host);identity.sourceHash="";expect(()=>compareProbeActual(plan,identity,"web")).toThrow();
  });
});
