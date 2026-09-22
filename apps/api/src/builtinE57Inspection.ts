import {lstat,mkdtemp,realpath,rm} from "node:fs/promises";
import path from "node:path";
import {runIndustrialJob,type IndustrialJobRequest} from "./industrialJobExecutor.js";
import {auditE57PointBlocks,hashE57File} from "./e57PointBlockAudit.js";

export interface E57InspectionInput {
  source:string;
  executable:string;
  attemptRoot:string;
  signal?:AbortSignal;
  limits?:IndustrialJobRequest["limits"];
  registerResourceExit?:((exit:Promise<void>)=>void);
}

/** 服务端固定 EXE 与私有 attempt 根目录；仅返回 inspect，不改活动模型。 */
export async function inspectBuiltinE57(input:E57InspectionInput){
  input.signal?.throwIfAborted();
  if(!path.isAbsolute(input.source)||!path.isAbsolute(input.executable)||!path.isAbsolute(input.attemptRoot))throw new Error("E57 路径必须由服务端解析");
  const sourceInfo=await lstat(input.source),executableInfo=await lstat(input.executable);
  if(!sourceInfo.isFile()||sourceInfo.isSymbolicLink()||sourceInfo.size>1024**3||!executableInfo.isFile()||executableInfo.isSymbolicLink())throw new Error("E57 输入或 Reader 无效");
  const root=await realpath(input.attemptRoot),attempt=await mkdtemp(path.join(root,"e57-"));
  const output=path.join(attempt,"inspection");
  try{
    const source=await hashE57File(input.source,input.signal);
    const receipt=await runIndustrialJob({executable:input.executable,arguments:[input.source,"--output",output],payload:{},
      limits:input.limits??{timeoutMs:300_000,maxMemoryMb:1024,maxCpuPercent:100},signal:input.signal,
      registerResourceExit:input.registerResourceExit,maxOutputBytes:1024,label:"E57"});
    const value=receipt as Record<string,unknown>|null;
    if(!value||value.schemaVersion!==2||value.status!=="inspect"||value.manifest!=="manifest.json")throw new Error("E57 Reader 回执无效");
    const audited=await auditE57PointBlocks(output,input.signal);
    if(value.points!==audited.points||value.validPoints!==audited.validPoints||value.invalidPoints!==audited.invalidPoints||value.scanCount!==audited.manifest.scans.length)throw new Error("E57 Reader 回执与点块不一致");
    const after=await hashE57File(input.source,input.signal);
    if(after.sha256!==source.sha256||after.bytes!==source.bytes)throw new Error("E57 源文件在读取期间发生变化");
    return {status:"inspect" as const,productionReady:false as const,directory:output,source,...audited};
  }catch(error){
    // attempt 为本次 mkdtemp 独占目录；退出确认后才回收，永不触碰旧版本。
    if(path.dirname(attempt)!==root)throw new Error("E57 attempt 路径越界");
    await rm(attempt,{recursive:true,force:true});throw error;
  }
}
