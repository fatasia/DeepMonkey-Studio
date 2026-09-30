import {describe,it,expect} from "vitest";
import sourceJson from "../../deep-engine-native/tests/fixtures/runtime-package-v1.json";
import manifestJson from "../fixtures/j3-hdr-flat-normal-v1.json";
import fixtureJson from "../fixtures/j3-texture-coverage-v1.json";
import type {DeepRuntimePackageV1} from "../src/runtimePackage/types.js";
import {parseDeepRuntimePackage} from "../src/runtimePackage/serialization.js";
import {runtimeContentSha256} from "../src/runtimePackage/hash.js";
import {buildTextureCoveragePlan,textureScenarioPackage,srgbByte,type TextureCoverageFixture} from "./j3TextureCoverageFixture.js";
import type {J3NormalShadowManifest} from "./j3NormalShadowMatrix.js";
const source=sourceJson as unknown as DeepRuntimePackageV1,manifest=manifestJson as unknown as J3NormalShadowManifest,f=fixtureJson as TextureCoverageFixture;
describe("Gate D texture fixture admission",()=>{
  it("keeps original85 and admits all derived runtime packages with real texture payload hashes",()=>{
    const plan=buildTextureCoveragePlan(source,manifest,f);
    expect(plan.cameras.map(c=>c.points.length)).toEqual([45,40]);
    for(const c of plan.cameras){
      const stable=c.points.filter(p=>p.byScenario["base-uv1"]!.stable);
      expect(stable.length).toBe(c.id==="axis"?25:19);
      expect(new Set(stable.map(p=>p.byScenario["base-uv1"]!.texel)).size).toBe(4);
      const alpha=c.points.filter(p=>p.byScenario.mask!.stable).map(p=>p.byScenario.mask!.expectedCoverage);
      expect(alpha).toContain(true);expect(alpha).toContain(false);
    }
    for(const s of plan.scenarios){
      expect(parseDeepRuntimePackage(s.packageText).valid).toBe(true);
      expect(runtimeContentSha256(s.package.payloads[s.package.entrypoints.renderPacket])).toBe(s.packetHash);
    }
    expect(new Set(plan.scenarios.map(s=>s.packageHash)).size).toBe(7);
  });
  it("preserves MIRROR, UV1 and transformed slot and cannot admit stale texture payload identity",()=>{
    const s=textureScenarioPackage(source,f,"base-uv1"),p=s.package.payloads[s.package.entrypoints.renderPacket] as any;
    expect(p.instances[3].transform[0]).toBeLessThan(0);
    expect(p.materials[1].baseColorTexture).toMatchObject(f.transform);
    p.textures[0].data[0]=255;
    expect(parseDeepRuntimePackage(JSON.stringify(s.package)).valid).toBe(false);
  });
  it("distinguishes independently decoded sRGB bytes from MR linear and freezes alpha controls",()=>{
    expect(srgbByte(128)).toBeCloseTo(.2158605,6);
    expect(Math.abs(srgbByte(128)-128/255)).toBeGreaterThan(.28);
    const mask=textureScenarioPackage(source,f,"mask"),blend=textureScenarioPackage(source,f,"blend");
    expect((mask.package.payloads[mask.package.entrypoints.renderPacket] as any).materials[1]).toMatchObject({alphaMode:"MASK",alphaCutoff:.5});
    expect((blend.package.payloads[blend.package.entrypoints.renderPacket] as any).materials[1]).toMatchObject({alphaMode:"BLEND",baseColorAlpha:.75});
  });
  it("rejects unknown scenario, changed gate, invalid texels and missing original points",()=>{
    expect(()=>textureScenarioPackage(source,f,"unknown")).toThrow("Unknown");
    expect(()=>buildTextureCoveragePlan(source,manifest,{...f,hdrTolerance:.003})).toThrow("frozen");
    expect(()=>textureScenarioPackage(source,{...f,baseBytes:[256]},"base-uv0")).toThrow("texels");
    const m=JSON.parse(JSON.stringify(manifest));m.cameras[0]!.subsets[0]!.pixels.pop();
    expect(()=>buildTextureCoveragePlan(source,m,f)).toThrow("original85");
  });
});
