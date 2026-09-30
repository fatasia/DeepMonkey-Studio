import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {bloomTextureInput,webBloomTextureReference,nativeBloomTextureReference,type BloomTextureFixture} from "./j3BloomTextureReference.js";
import {DEFAULT_PBR_BLOOM_OPTIONS} from "../src/webgpu/pbrPostProcessChain.js";
const fixture=JSON.parse(readFileSync(new URL("../fixtures/j3-bloom-texture-v1.json",import.meta.url),"utf8")) as BloomTextureFixture;
describe("frozen Bloom texture legal profiles",()=>{
  it("uses production Web defaults and preserves alpha in all full texture oracles",()=>{
    expect(fixture.web).toEqual(DEFAULT_PBR_BLOOM_OPTIONS);
    for(const id of fixture.cases){
      const source=bloomTextureInput(id,fixture.width,fixture.height),web=webBloomTextureReference(source,fixture.web),native=nativeBloomTextureReference(source,fixture.native);
      expect(web.pixels.every(Number.isFinite)).toBe(true);expect(native.display.pixels.every(Number.isFinite)).toBe(true);
      expect(native.blurred.width).toBe(32);expect(native.blurred.height).toBe(32);
      for(let pixel=0;pixel<source.width*source.height;pixel++){
        expect(web.pixels[pixel*4+3]).toBe(source.pixels[pixel*4+3]);expect(native.display.pixels[pixel*4+3]).toBe(source.pixels[pixel*4+3]);
      }
    }
  });
  it("retains edge halos and explicit profile differences",()=>{
    const input=bloomTextureInput("edge-spot",64,64),web=webBloomTextureReference(input,fixture.web),native=nativeBloomTextureReference(input,fixture.native);
    expect(web.pixels[(5*64+5)*4]).toBeGreaterThan(0);expect(native.blurred.pixels[(2*32+2)*4]).toBeGreaterThan(0);
    expect(web.pixels[(5*64+5)*4]).not.toBe(native.linearComposite.pixels[(5*64+5)*4]);
    expect(()=>bloomTextureInput("unknown",64,64)).toThrow();
  });
});
