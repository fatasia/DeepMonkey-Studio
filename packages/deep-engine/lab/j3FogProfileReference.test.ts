import {readFileSync} from "node:fs";
import {it,expect} from "vitest";
import {fogSourcePixels,fogWebReference,fogWebOptions,type FogProfileFixture} from "./j3FogProfileReference.js";
import {validateVolumetricFogOptions} from "../src/fog/volumetricFogPassCpu.js";
const fixture=JSON.parse(readFileSync(new URL("../fixtures/j3-fog-profiles-v1.json",import.meta.url),"utf8")) as FogProfileFixture;
it("covers eight legal Web height/HG/steps profiles with exact alpha and zero control",()=>{
  expect(fixture.profiles.length).toBe(8);
  for(const p of fixture.profiles){const ref=fogWebReference(fixture,p),source=fogSourcePixels(fixture);
    expect(ref.scatter.length).toBe(16*8*4);expect(ref.composite.every(Number.isFinite)).toBe(true);
    for(let i=3;i<source.length;i+=4)expect(ref.composite[i]).toBe(source[i]);
    if(p.id==="zero")expect(ref.composite).toEqual(Array.from(source));
  }
});
it("retains Web view-origin height and formal illegal profile boundaries",()=>{
  const base=fixture.profiles[1]!;
  expect(()=>validateVolumetricFogOptions(fogWebOptions(fixture,{...base,steps:1}))).toThrow();
  expect(()=>validateVolumetricFogOptions(fogWebOptions(fixture,{...base,height:0}))).toThrow();
  expect(()=>validateVolumetricFogOptions(fogWebOptions(fixture,{...base,g:1}))).toThrow();
  expect(fogWebReference(fixture,fixture.profiles[2]!).composite).not.toEqual(fogWebReference(fixture,fixture.profiles[3]!).composite);
});
