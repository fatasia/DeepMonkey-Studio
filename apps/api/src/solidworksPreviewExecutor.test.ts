import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditSolidworksPreviewOutput, runSolidworksPreview } from "./solidworksPreviewExecutor.js";

const root = path.resolve(import.meta.dirname, "../../..");
const readerPath = "C:/Users/rain/AppData/Local/Temp/bim-cadmpeg-20260918-target/archive-isolated/release/cadmpeg.exe";
const samples = path.join(root,"data/external-assets/industrial-format-plan/samples/solidworks-sheetmetal-20260918");
const directories: string[] = [];
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true});});
async function fixture(index=0) {
  const directory = await mkdtemp(path.join(tmpdir(),"bim-sw-job-"));directories.push(directory);
  const manifest=JSON.parse(await readFile(path.join(samples,"manifest.json"),"utf8"));
  const sample=manifest.records[index];
  return {directory,request:{readerPath,sourcePath:path.join(samples,sample.relativePath),sourceSha256:sample.sha256,outputDir:path.join(directory,"preview")}};
}

describe.skipIf(process.platform!=="win32"||!existsSync(readerPath)||!existsSync(samples))("real isolated SolidWorks preview",()=>{
  it.each([1,2,3,4])("preserves real sample %i through the isolated API bridge",async index=>{
    const {request}=await fixture(index);
    const prior=JSON.parse(await readFile(path.join(root,"test-output/industrial-solidworks/geometry-20260918/full/evidence.json"),"utf8"));
    const expected=prior.results[index],result=await runSolidworksPreview(request);
    expect(result.geometrySha256).toBe(expected.glbSha256);expect(result.triangles).toBe(expected.triangles);
    const sidecar=JSON.parse(await readFile(path.join(request.outputDir,"preview.json"),"utf8"));
    expect(sidecar.sourceMap).toHaveLength(expected.meshes);
    expect(sidecar.diagnostics).toEqual(expect.arrayContaining(expected.checkFindings));
  },20000);
  it("decodes the real source under Job limits and preserves the established GLB identity",async()=>{
    const {request}=await fixture();let exit:Promise<void>|undefined;
    const result=await runSolidworksPreview(request,{registerResourceExit:value=>{exit=value;}});await exit;
    expect(result.status).toBe("preview");expect(result.triangles).toBe(8872);
    expect(result.geometrySha256).toBe("e43c2413b5706a36c28a6e4924742bc5b5e66e62e81daeae14a592dca519c381");
    const bytes=await readFile(path.join(request.outputDir,"geometry.glb"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.geometrySha256);
    expect((await readdir(request.outputDir)).sort()).toEqual(["geometry.glb","preview.json"]);
    await expect(runSolidworksPreview(request)).rejects.toThrow("不能覆盖");
    expect(await readFile(path.join(request.outputDir,"geometry.glb"))).toEqual(bytes);
    const sidecarPath=path.join(request.outputDir,"preview.json"),sidecar=JSON.parse(await readFile(sidecarPath,"utf8"));
    await writeFile(sidecarPath,JSON.stringify({...sidecar,status:"ready"}));
    await expect(auditSolidworksPreviewOutput(request,result)).rejects.toThrow("质量回执不一致");
    await writeFile(sidecarPath,JSON.stringify(sidecar));
    const altered=Buffer.from(bytes);altered[altered.length-1]^=1;await writeFile(path.join(request.outputDir,"geometry.glb"),altered);
    await expect(auditSolidworksPreviewOutput(request,result)).rejects.toThrow("哈希不匹配");
  },20000);
  it("rejects wrong source and reader identities without publishing an output directory",async()=>{
    const {request,directory}=await fixture();
    await expect(runSolidworksPreview({...request,sourceSha256:"0".repeat(64)})).rejects.toThrow("源文件身份不匹配");
    const altered=path.join(directory,"reader.exe");await writeFile(altered,"not a reader");
    await expect(runSolidworksPreview({...request,readerPath:altered})).rejects.toThrow("Reader 身份不匹配");
    expect(existsSync(request.outputDir)).toBe(false);
  },20000);
  it("honors cancellation before launching and does not create artifacts",async()=>{
    const {request}=await fixture(),controller=new AbortController();controller.abort();
    await expect(runSolidworksPreview(request,{signal:controller.signal})).rejects.toThrow();
    expect(existsSync(request.outputDir)).toBe(false);
  });
  it("waits for an in-flight Job to exit on cancellation",async()=>{
    const {request,directory}=await fixture(),controller=new AbortController();let exit:Promise<void>|undefined;
    const pending=runSolidworksPreview(request,{signal:controller.signal,registerResourceExit:value=>{exit=value;}});
    const rejected=expect(pending).rejects.toThrow("取消");
    const timer=setTimeout(()=>controller.abort(),25);
    try { await rejected;expect(exit).toBeDefined();await exit;expect(existsSync(request.outputDir)).toBe(false);expect(await readdir(directory)).toEqual([]); }
    finally { clearTimeout(timer); }
  },10000);
});
