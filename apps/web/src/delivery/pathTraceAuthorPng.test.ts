import {describe,expect,it} from "vitest";
import {createHash} from "node:crypto";
import {encodePathTracePng,sha256Hex,withSrgbChunk} from "./pathTraceAuthorPng";

function minimalPng(width:number,height:number){const bytes=new Uint8Array(33+12);const view=new DataView(bytes.buffer);
  bytes.set([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);view.setUint32(8,13);bytes.set([0x49,0x48,0x44,0x52],12);
  view.setUint32(16,width);view.setUint32(20,height);bytes.set([8,6,0,0,0],24);bytes.set([0x49,0x45,0x4e,0x44],37);return bytes;}
describe("sRGB PNG packaging",()=>{
  it("inserts a CRC-correct sRGB chunk right after IHDR and keeps the rest intact",()=>{
    const source=minimalPng(4,2),out=withSrgbChunk(source),view=new DataView(out.buffer);
    expect(out.length).toBe(source.length+13);expect(view.getUint32(33)).toBe(1);expect(new TextDecoder().decode(out.subarray(37,41))).toBe("sRGB");
    expect(out[41]).toBe(0);expect(view.getUint32(42)).toBe(0xaece1ce9);// the CRC every sRGB PNG carries for intent 0
    expect(out.subarray(0,33)).toEqual(source.subarray(0,33));expect(out.subarray(46)).toEqual(source.subarray(33));
  });
  it("rejects bytes that are not a PNG",()=>{expect(()=>withSrgbChunk(new Uint8Array(64))).toThrow(/PNG/);});
  it("encodes through an injected canvas encoder and hashes with sha256",async()=>{
    const image={width:4,height:2,data:new Uint8ClampedArray(32)};let seen:unknown;
    const png=await encodePathTracePng(image,async value=>{seen=value;return new Blob([minimalPng(4,2)]);});
    expect(seen).toBe(image);expect(await sha256Hex(png)).toBe(createHash("sha256").update(png).digest("hex"));
  });
});
