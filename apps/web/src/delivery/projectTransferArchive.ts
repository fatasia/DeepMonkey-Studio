import { api } from "../api";
import { loadViewerAssetBuffer } from "../viewer/viewerAssetTransport";
import { createProjectTransfer, sanitizeTransferUrl, validateProjectTransfer, type ProjectTransferDocument } from "./projectTransferModel";

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
export interface ProjectTransferArchive { document: ProjectTransferDocument; files: Map<string, File>; }

export async function exportProjectTransfer(projectId: string, signal: AbortSignal, progress: (message: string) => void): Promise<Blob> {
  const [project, scenes, applications] = await Promise.all([api.getProject(projectId), api.listScenes(projectId), api.listApplications(projectId)]);
  signal.throwIfAborted();
  const document = createProjectTransfer(project, scenes, applications);
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  let bytes = 0;
  for (const file of document.files) {
    signal.throwIfAborted(); progress(`正在打包 ${file.name}`);
    try {
      if (!file.sourceUrl) throw new Error("缺少源文件");
      const dependency = document.dependencies.find(item => item.fileId === file.id);
      const content = dependency ? new TextEncoder().encode(await api.readScriptDependency(projectId, dependency.originalId)).buffer
        : await loadViewerAssetBuffer(file.sourceUrl, file.name, { signal, timeoutMs: 120_000 });
      if (content.byteLength > MAX_FILE_BYTES || bytes + content.byteLength > MAX_PACKAGE_BYTES) throw new Error("项目包超过文件大小限制");
      bytes += content.byteLength;
      file.sha256 = await transferSha256(content); file.bytes = content.byteLength;
      zip.file(file.path, content);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message.includes("大小限制")) throw error;
      file.missing = true;
    }
  }
  signal.throwIfAborted();
  for (const file of document.files) file.sourceUrl = sanitizeTransferUrl(file.sourceUrl);
  zip.file("project.json", JSON.stringify(document, null, 2));
  progress("正在生成项目包");
  return zip.generateAsync({ type: "blob", compression: "STORE" });
}

export async function readProjectTransfer(file: File): Promise<ProjectTransferArchive> {
  if (file.size > MAX_PACKAGE_BYTES) throw new Error("项目包超过 1 GB");
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(zip.files);
  if (entries.length > 8192) throw new Error("项目包条目超过限制");
  let expanded = 0;
  for (const entry of entries) {
    expanded += (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (expanded > MAX_PACKAGE_BYTES) throw new Error("项目包展开后超过 1 GB");
  }
  const entry = zip.file("project.json");
  if (!entry) throw new Error("项目包缺少 project.json");
  if (((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0) > 16 * 1024 * 1024) throw new Error("项目包清单超过 16 MB");
  const document: unknown = JSON.parse(await entry.async("text"));
  validateProjectTransfer(document);
  const files = new Map<string, File>();
  for (const asset of document.files) {
    const content = zip.file(asset.path);
    if (!content) { asset.missing = true; continue; }
    const bytes = await content.async("arraybuffer");
    if (bytes.byteLength > MAX_FILE_BYTES || bytes.byteLength !== asset.bytes || !asset.sha256 || await transferSha256(bytes) !== asset.sha256) throw new Error(`文件校验失败：${asset.name}`);
    files.set(asset.id, new File([bytes], asset.name));
  }
  return { document, files };
}

export async function transferSha256(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
}
