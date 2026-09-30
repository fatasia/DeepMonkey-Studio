import {expect,it} from "vitest";
import {readFileSync} from "node:fs";
import {authorModeFactor,buildWebAuthorModesPlan,compareWebAuthorModes} from "./j3WebAuthorFogModes.js";
it("uses authored smoothstep depth with exact near/far endpoints",()=>{
  const mode={id:"linear",kind:"linear" as const,near:2,far:7};
  expect(authorModeFactor(mode,1)).toBe(0);expect(authorModeFactor(mode,7)).toBe(1);expect(authorModeFactor(mode,4.5)).toBe(.5);
});
it("bounded author eight-step homogeneous extinction has exponential closed form",()=>{
  const mode={id:"volume",kind:"volumetric" as const,density:.2};
  expect(authorModeFactor(mode,0)).toBe(0);expect(authorModeFactor(mode,8)).toBeCloseTo(1-Math.exp(-1.6),15);
});
it("retains all 85 original points and rejects incomplete actual frames, alpha and shader identity",()=>{
  const source=JSON.parse(readFileSync(new URL("../../deep-engine-native/tests/fixtures/runtime-package-v1.json",import.meta.url),"utf8"));
  const manifest=JSON.parse(readFileSync(new URL("../fixtures/j3-hdr-flat-normal-v1.json",import.meta.url),"utf8"));
  const fixture=JSON.parse(readFileSync(new URL("../fixtures/j3-web-author-fog-modes-v1.json",import.meta.url),"utf8")),plan=buildWebAuthorModesPlan(source,manifest,fixture);
  const host={passed:true,packageHash:plan.packageHash,packetHash:plan.packetHash,errors:[],sourceHash:"f".repeat(64),
    frames:plan.cameras.flatMap(c=>plan.profiles.flatMap(profile=>[0,1].map(round=>({cameraId:c.id,profile:profile.id,round,hdr:c.points.map(p=>[...p.expected[profile.id]!,1]),rgbaHash:"f".repeat(64),vp:Array.from(c.expectedVP)}))))};
  expect(compareWebAuthorModes(plan,host).pointsCompared).toBe(340);
  const missing=structuredClone(host);missing.frames[0]!.hdr.pop();expect(()=>compareWebAuthorModes(plan,missing)).toThrow();
  const alpha=structuredClone(host);alpha.frames[0]!.hdr[0]![3]=0;expect(()=>compareWebAuthorModes(plan,alpha)).toThrow();
  const identity=structuredClone(host);identity.sourceHash="";expect(()=>compareWebAuthorModes(plan,identity)).toThrow();
});
