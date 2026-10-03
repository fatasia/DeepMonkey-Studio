import {describe,expect,it} from "vitest";
import {PATH_TRACE_RESOLUTIONS,estimatePathTraceMemory,fitPathTraceWorkers,formatPathTraceDuration,pathTraceHeight,pathTraceMemoryBudgetBytes,
  pathTracePacketBytes,pathTraceTierState,pathTraceWorkerCap,recordPathTraceThroughput,estimatePathTraceSeconds,pathTraceThroughput} from "./pathTraceAuthorBudget";
const MIB=1024*1024;
describe("path trace worker count, tiers and memory budget",()=>{
  it("keeps one core for the UI, caps at 8 and never returns 0",()=>{
    expect([undefined,1,2,4,8,9,32].map(pathTraceWorkerCap)).toEqual([1,1,1,3,7,8,8]);
    expect(pathTraceWorkerCap(Number.NaN)).toBe(1);
  });
  it("offers 16:9 tiers up to 1920×1080",()=>{
    expect(PATH_TRACE_RESOLUTIONS).toEqual([160,320,640,1280,1920]);
    expect(pathTraceHeight(1920)).toBe(1080);expect(pathTraceHeight(1280)).toBe(720);
  });
  it("budget is a quarter of device memory, clamped to 384 MiB–2 GiB",()=>{
    expect(pathTraceMemoryBudgetBytes(8)).toBe(2048*MIB);expect(pathTraceMemoryBudgetBytes(0.5)).toBe(384*MIB);expect(pathTraceMemoryBudgetBytes(undefined)).toBe(1024*MIB);
  });
  it("sums packet geometry and texture bytes",()=>{
    const bytes=pathTracePacketBytes({geometries:[{vertices:new Float32Array(6),indices:new Uint32Array(3),uv0:new Float32Array(4)}],
      textures:[{data:new Uint8Array(16),mipmaps:[{data:new Uint8Array(4)}]}]} as never);
    expect(bytes).toBe(24+12+16+16+4);
  });
  it("shrinks the worker count before disabling a tier, and disables only when one worker does not fit",()=>{
    const packet=120*MIB,budget=1024*MIB;
    const workers=fitPathTraceWorkers(1920,7,packet,budget);expect(workers).toBeGreaterThanOrEqual(1);expect(workers).toBeLessThan(7);
    expect(estimatePathTraceMemory(1920,workers,packet).totalBytes).toBeLessThanOrEqual(budget);
    expect(estimatePathTraceMemory(1920,workers+1,packet).totalBytes).toBeGreaterThan(budget);
    expect(pathTraceTierState(1920,7,packet,budget).available).toBe(true);
    const huge=pathTraceTierState(1920,7,600*MIB,budget);expect(huge).toMatchObject({available:false,workers:0});
    expect(huge.estimate.totalBytes).toBeGreaterThan(budget);
  });
  it("1080p planes cost 50 MiB of accumulation; small scenes fit the default budget at 7 workers",()=>{
    const estimate=estimatePathTraceMemory(1920,7,10*MIB);expect(estimate.accumulationBytes).toBe(1920*1080*24);
    expect(pathTraceTierState(1920,7,10*MIB,1024*MIB).workers).toBe(7);
  });
  it("estimates duration from the last real throughput and formats it",()=>{
    const before=estimatePathTraceSeconds(320,64,1);recordPathTraceThroughput(320,2,10,1000);
    expect(pathTraceThroughput()).toBeCloseTo(320*180*10/1/2,5);expect(estimatePathTraceSeconds(320,64,2)).toBeCloseTo(6.4,5);
    recordPathTraceThroughput(320,2,1,1000);expect(pathTraceThroughput()).toBeCloseTo(320*180*5,5);
    expect(before).toBeGreaterThan(0);
    expect([formatPathTraceDuration(4),formatPathTraceDuration(600),formatPathTraceDuration(7200),formatPathTraceDuration(Infinity)]).toEqual(["4 s","10 min","2.0 h","—"]);
  });
});
