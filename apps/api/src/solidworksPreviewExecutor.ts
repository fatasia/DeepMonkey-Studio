import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { auditGlbGeometry } from "./converterOutputAudit.js";
import type { SolidworksPreviewRequest } from "./solidworksPreviewConversion.js";
import { runIndustrialJob, type IndustrialJobRequest } from "./industrialJobExecutor.js";

export async function runSolidworksPreview(request: SolidworksPreviewRequest,
  options: Pick<IndustrialJobRequest, "signal" | "registerResourceExit"> = {}) {
  options.signal?.throwIfAborted();
  if(!path.isAbsolute(request.outputDir))throw new Error("SolidWorks 输出必须由服务端解析为绝对路径");
  const existing=await lstat(request.outputDir).catch(error=>{if(error.code!=="ENOENT")throw error;return undefined;});
  if(existing)throw new Error("SolidWorks 输出目录已存在，不能覆盖");
  const parent=path.dirname(request.outputDir);await mkdir(parent,{recursive:true});
  const attempt=await mkdtemp(path.join(parent,".solidworks-job-"));
  const workerRequest={...request,outputDir:path.join(attempt,"preview")};
  try {
  const development = import.meta.url.endsWith(".ts");
  const worker = fileURLToPath(new URL(development ? "./solidworksPreviewWorker.ts" : "./solidworksPreviewWorker.js", import.meta.url));
  const receipt = await runIndustrialJob({ ...options, label: "SolidWorks", executable: process.execPath,
    arguments: [...(development ? ["--conditions=development", "--import", "tsx"] : []), "--max-old-space-size=1024", worker],
    payload: workerRequest, limits: { timeoutMs: 180000, maxMemoryMb: 2048, maxCpuPercent: 100 } }) as Record<string, unknown>;
  if (receipt?.status === "error" && typeof receipt.message === "string") throw new Error(receipt.message.slice(0, 1000));
  if (receipt?.schemaVersion !== 1 || receipt.status !== "preview" || receipt.sourceSha256 !== request.sourceSha256
    || receipt.geometry !== "geometry.glb" || receipt.sidecar !== "preview.json"
    || typeof receipt.geometrySha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.geometrySha256)
    || ![receipt.bytes, receipt.triangles, receipt.vertices].every(value => Number.isSafeInteger(value) && Number(value) > 0)) throw new Error("SolidWorks Worker 回执无效");
  await auditSolidworksPreviewOutput(workerRequest, receipt);
  options.signal?.throwIfAborted();
  await rename(workerRequest.outputDir,request.outputDir);
  return receipt;
  } finally {
    // 宿主确认进程树退出后清理本次独占目录，包含被中止 Worker 的 staging。
    if(path.dirname(attempt)!==parent)throw new Error("SolidWorks attempt 路径越界");
    await rm(attempt,{recursive:true,force:true});
  }
}

export async function auditSolidworksPreviewOutput(request: SolidworksPreviewRequest, receipt: Record<string, unknown>): Promise<void> {
  const geometryPath=path.join(request.outputDir,"geometry.glb"),sidecarPath=path.join(request.outputDir,"preview.json");
  const [geometryInfo,sidecarInfo]=await Promise.all([lstat(geometryPath),lstat(sidecarPath)]);
  if (!geometryInfo.isFile() || geometryInfo.isSymbolicLink() || geometryInfo.size > 512*1024*1024 || geometryInfo.size !== receipt.bytes
    || !sidecarInfo.isFile() || sidecarInfo.isSymbolicLink() || sidecarInfo.size > 16*1024*1024) throw new Error("SolidWorks 预览产物类型或体量无效");
  const bytes=await readFile(geometryPath);
  if(createHash("sha256").update(bytes).digest("hex")!==receipt.geometrySha256)throw new Error("SolidWorks 预览几何哈希不匹配");
  const sidecar=JSON.parse(await readFile(sidecarPath,"utf8"));
  if(sidecar.status!=="partial-geometry-preview" || sidecar.sourceSha256!==request.sourceSha256
    || sidecar.triangles!==receipt.triangles || sidecar.vertices!==receipt.vertices
    || !Array.isArray(sidecar.sourceMap) || !Array.isArray(sidecar.diagnostics)
    || !Number.isFinite(sidecar.maximumFloat32ErrorMm) || sidecar.maximumFloat32ErrorMm<0 || sidecar.maximumFloat32ErrorMm>.01)throw new Error("SolidWorks 预览来源或质量回执不一致");
  await auditGlbGeometry(geometryPath);
}
