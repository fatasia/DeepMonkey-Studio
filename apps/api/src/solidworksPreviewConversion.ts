import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { exportSldprtPreview } from "./solidworksDisplayPreview.js";

export const SOLIDWORKS_READER_SHA256 = "14de5287e42a27569e0fab333a99522a455c92502fbfd62cde26d1d0e31d4568";
export interface SolidworksPreviewRequest {
  readerPath: string;
  sourcePath: string;
  sourceSha256: string;
  outputDir: string;
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function boundedFile(file: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error("SolidWorks 文件类型或体量不符合限制");
  const bytes = await readFile(file);
  if (bytes.length !== info.size || bytes.length > maxBytes) throw new Error("SolidWorks 文件在读取时发生变化");
  return bytes;
}

/** 仅由 Windows Job 内的受限进程调用；原始检查失败保留在 preview sidecar。 */
export async function convertSolidworksPreview(request: SolidworksPreviewRequest) {
  if (!request || ![request.readerPath, request.sourcePath, request.outputDir].every(value => typeof value === "string" && path.isAbsolute(value))
    || !/^[a-f0-9]{64}$/.test(request.sourceSha256)) throw new Error("SolidWorks Worker 请求无效");
  if (sha(await boundedFile(request.readerPath, 128 * 1024 * 1024)) !== SOLIDWORKS_READER_SHA256) throw new Error("SolidWorks Reader 身份不匹配");
  if (sha(await boundedFile(request.sourcePath, 256 * 1024 * 1024)) !== request.sourceSha256) throw new Error("SolidWorks 源文件身份不匹配");
  const existing = await lstat(request.outputDir).catch(error => { if (error.code !== "ENOENT") throw error; return undefined; });
  if (existing) throw new Error("SolidWorks 输出目录已存在，不能覆盖");
  const parent = path.dirname(request.outputDir);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(path.join(parent, ".solidworks-preview-"));
  try {
    const irPath = path.join(staging, "source.cadir.json"), decodePath = path.join(staging, "decode.json"), checkPath = path.join(staging, "check.json");
    // 对固定输入快照解码，不在哈希校验后再次读取可变源文件。
    const sourcePath = path.join(staging, "source.sldprt");
    const source = await boundedFile(request.sourcePath, 256 * 1024 * 1024);
    if (sha(source) !== request.sourceSha256) throw new Error("SolidWorks 源文件在校验后发生变化");
    await writeFile(sourcePath, source, { flag: "wx" });
    const execute = (args: string[], allowFindings = false) => {
      const result = spawnSync(request.readerPath, args, { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024, encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0 && !(allowFindings && result.status === 1)) throw new Error(`SolidWorks Reader 失败：${result.status}`);
    };
    execute(["dump", sourcePath, "--limits", "service", "-o", irPath, "--report", decodePath]);
    execute(["check", irPath, "--limits", "service", "--report", checkPath], true);
    const ir = JSON.parse((await boundedFile(irPath, 256 * 1024 * 1024)).toString("utf8"));
    const report = JSON.parse((await boundedFile(decodePath, 16 * 1024 * 1024)).toString("utf8"));
    report.check_report = JSON.parse((await boundedFile(checkPath, 16 * 1024 * 1024)).toString("utf8")).check_report;
    const output = await exportSldprtPreview(ir, report, request.sourceSha256);
    const fidelityPath = path.join(staging, "source.cadir.fidelity.json");
    const sourceFidelity = JSON.parse((await boundedFile(fidelityPath, 16 * 1024 * 1024)).toString("utf8"));
    await writeFile(path.join(staging, "geometry.glb"), output.bytes, { flag: "wx" });
    await writeFile(path.join(staging, "preview.json"), JSON.stringify({ ...output.sidecar, sourceFidelity }), { flag: "wx" });
    // 中间文件仅在本次生成的 staging 内，不随预览交付。
    for (const file of [sourcePath, irPath, decodePath, checkPath, fidelityPath]) await rm(file);
    await rename(staging, request.outputDir);
    return { schemaVersion: 1, status: "preview" as const, sourceSha256: request.sourceSha256,
      geometry: "geometry.glb", sidecar: "preview.json", geometrySha256: sha(output.bytes),
      bytes: output.bytes.length, triangles: output.sidecar.triangles, vertices: output.sidecar.vertices };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
