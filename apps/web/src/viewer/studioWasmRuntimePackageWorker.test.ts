import { afterEach, expect, it, vi } from "vitest";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { compileStudioWasmRuntimePackage } from "./studioWasmRuntimePackage";

const scene={id:"worker",models:[],primitives:[],measurements:[],camera:{position:{x:0,y:2,z:5},target:{x:0,y:0,z:0}}} as unknown as SceneSnapshot;
const project={models:[]} as unknown as ProjectRecord;
afterEach(()=>vi.unstubAllGlobals());
it("uses the formal module Worker entry and keeps the author thread free of the compiler",async()=>{
  const constructed: {url:URL;options:WorkerOptions;host:MockWorker}[]=[];
  class MockWorker {
    onmessage: ((event:MessageEvent)=>void)|null=null; onerror=null; onmessageerror=null;
    terminated=false; posted:unknown;
    constructor(url:URL,options:WorkerOptions){constructed.push({url,options,host:this});}
    postMessage(input:unknown){this.posted=input;queueMicrotask(()=>this.onmessage?.(new MessageEvent("message",{data:{bytes:new Uint8Array([7]),canonicalHash:"a".repeat(64)}})));}
    terminate(){this.terminated=true;}
  }
  vi.stubGlobal("Worker",MockWorker);
  expect(await compileStudioWasmRuntimePackage(scene,project,new AbortController().signal)).toEqual({bytes:new Uint8Array([7]),canonicalHash:"a".repeat(64)});
  expect(constructed).toHaveLength(1);
  expect(constructed[0]!.url.pathname).toContain("studioWasmCompilationWorker.ts");
  expect(constructed[0]!.options).toEqual({type:"module"});
  expect(constructed[0]!.host.terminated).toBe(true);
  expect(constructed[0]!.host.posted).toMatchObject({scene,models:[],irradianceProbes:null});
});
it("rejects Worker absence instead of falling back to synchronous author-thread compilation",async()=>{
  vi.stubGlobal("Worker",undefined);
  await expect(compileStudioWasmRuntimePackage(scene,project,new AbortController().signal)).rejects.toThrow("不支持 WASM 后台编译");
});
