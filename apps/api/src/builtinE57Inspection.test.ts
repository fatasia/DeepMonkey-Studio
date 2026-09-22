import {mkdtemp,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach,describe,expect,it} from "vitest";
import {inspectBuiltinE57} from "./builtinE57Inspection.js";
import {auditE57PointBlocks} from "./e57PointBlockAudit.js";

const root=fileURLToPath(new URL("../../../",import.meta.url));
const base=path.join(root,"data/external-assets/industrial-format-plan");
const executable=path.join(base,"build-trial/e57-reader-cli/Release/e57-reader.exe");
const source=path.join(base,"samples/extracted/libE57Format-test-data/self/ColouredCubeDouble.e57");
const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function attemptRoot(){const folder=await mkdtemp(path.join(tmpdir(),"e57-api-test-"));folders.push(folder);return folder;}

describe.skipIf(process.platform!=="win32")("E57 real Reader through shared Windows Job",()=>{
  it("consumes real RGB chunks only after child exit and keeps inspection separate from ready",async()=>{
    let exited=false;
    const output=await inspectBuiltinE57({source,executable,attemptRoot:await attemptRoot(),registerResourceExit:promise=>{void promise.then(()=>{exited=true;});}});
    expect(exited).toBe(true);expect(output.status).toBe("inspect");expect(output.productionReady).toBe(false);
    expect(output.points).toBe(7680);expect(output.blocks).toBe(2);expect(output.source.bytes).toBeGreaterThan(1000);
    expect(output.pointFile.sha256).toMatch(/^[a-f0-9]{64}$/);expect(output.manifest.worldBounds).toEqual([[-.5,-.5,-.5],[.5,.5,.5]]);
  },15000);
  it("preserves prior output while malformed source removes only its new attempt",async()=>{
    const folder=await attemptRoot();await writeFile(path.join(folder,"prior-ready.json"),"prior-ready");
    await expect(inspectBuiltinE57({source:path.join(path.dirname(source),"bad-crc.e57"),executable,attemptRoot:folder})).rejects.toThrow();
    expect(await readdir(folder)).toEqual(["prior-ready.json"]);expect(await readFile(path.join(folder,"prior-ready.json"),"utf8")).toBe("prior-ready");
  });
  it("cancels a spawned host, waits for exit, and removes its attempt",async()=>{
    const folder=await attemptRoot(),controller=new AbortController();let exit:Promise<void>|undefined;
    await expect(inspectBuiltinE57({source,executable,attemptRoot:folder,signal:controller.signal,registerResourceExit:promise=>{exit=promise;controller.abort();}})).rejects.toThrow("取消");
    expect(exit).toBeDefined();await exit;expect(await readdir(folder)).toEqual([]);
  });
  it("refuses pre-cancelled requests without creating an attempt",async()=>{
    const folder=await attemptRoot(),controller=new AbortController();controller.abort();
    await expect(inspectBuiltinE57({source,executable,attemptRoot:folder,signal:controller.signal})).rejects.toThrow();
    expect(await readdir(folder)).toEqual([]);
  });
  it("fails closed on a real zero-time budget and cleans partial output",async()=>{
    const folder=await attemptRoot();
    await expect(inspectBuiltinE57({source,executable,attemptRoot:folder,limits:{timeoutMs:0,maxMemoryMb:1024,maxCpuPercent:100}})).rejects.toThrow();
    expect(await readdir(folder)).toEqual([]);
  });
  it("audits source indices, world bounds and truncated point blocks",async()=>{
    const output=await inspectBuiltinE57({source,executable,attemptRoot:await attemptRoot()});
    const file=path.join(output.directory,"points.ndjson"),original=await readFile(file,"utf8");
    await writeFile(file,original.slice(0,-1));await expect(auditE57PointBlocks(output.directory)).rejects.toThrow("截断");
    const blocks=original.trim().split("\n").map(line=>JSON.parse(line));blocks[0].points[0][0]=12;
    await writeFile(file,blocks.map(value=>JSON.stringify(value)).join("\n")+"\n");await expect(auditE57PointBlocks(output.directory)).rejects.toThrow("源点序号");
    await writeFile(file,original);const manifestFile=path.join(output.directory,"manifest.json");
    const manifest=JSON.parse(await readFile(manifestFile,"utf8"));manifest.worldBounds[0][0]=-100;
    await writeFile(manifestFile,JSON.stringify(manifest));await expect(auditE57PointBlocks(output.directory)).rejects.toThrow("包围盒");
  },15000);
});
