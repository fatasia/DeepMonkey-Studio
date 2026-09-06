import { ROBOT_IMPORT_LIMITS, type RobotAssetDefinition } from "@bim-studio/contracts";
import type JSZip from "jszip";

const MAX_FILE = ROBOT_IMPORT_LIMITS.entryBytes, MAX_TOTAL = ROBOT_IMPORT_LIMITS.expandedBytes;
export const ROBOT_RESOURCE_PREFIX = "__robot_package__/";
export type RobotFiles = Map<string, Uint8Array<ArrayBuffer>>;

export function safeRobotPath(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new Error("机器人资源路径编码无效"); }
  if (!decoded || decoded.length > 512 || /[\\:\u0000-\u001f?#]/.test(decoded) || decoded.startsWith("/")) throw new Error("机器人只允许包内相对资源");
  const parts: string[] = [];
  for (const part of decoded.split("/")) {
    if (part === "..") { if (!parts.length) throw new Error("机器人资源路径超出文件包"); parts.pop(); }
    else if (part && part !== ".") parts.push(part);
  }
  if (!parts.length) throw new Error("机器人资源路径为空");
  return parts.join("/");
}

/** 解压前检查原始目录，不能依赖 JSZip 自动净化路径或覆盖重名条目。 */
function inspectZip(bytes: ArrayBuffer): void {
  const view = new DataView(bytes), raw = new Uint8Array(bytes);
  let end = -1;
  for (let index = bytes.byteLength - 22; index >= Math.max(0, bytes.byteLength - 65_557); index--) {
    if (view.getUint32(index, true) === 0x06054b50 && index + 22 + view.getUint16(index + 20, true) === bytes.byteLength) { end = index; break; }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error("机器人 ZIP 目录无效");
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true), total = 0;
  if (!count || count > ROBOT_IMPORT_LIMITS.maxEntries || view.getUint16(end + 8, true) !== count || offset + size !== end) throw new Error("机器人 ZIP 目录数量或范围超限");
  const names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error("机器人 ZIP 目录损坏");
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), compressed = view.getUint32(offset + 20, true), expanded = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameSize + extra + comment;
    if (next > end || flags & 1 || ![0, 8].includes(method) || view.getUint16(offset + 34, true) || expanded > MAX_FILE || compressed === 0xffffffff || (expanded > 1024 * 1024 && expanded > Math.max(compressed, 1) * 200)) throw new Error("机器人 ZIP 文件大小、加密或压缩比例不支持");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(offset + 46, offset + 46 + nameSize));
    if (name.split("/").includes("..")) throw new Error("机器人 ZIP 含越界路径");
    const mode = view.getUint32(offset + 38, true) >>> 16;
    if ((mode & 0xf000) !== 0 && (mode & 0xf000) !== (name.endsWith("/") ? 0x4000 : 0x8000)) throw new Error("机器人 ZIP 不允许符号链接或特殊文件");
    const safe = safeRobotPath(name).toLowerCase();
    if (names.has(safe)) throw new Error("机器人 ZIP 含重复路径");
    names.add(safe); total += expanded;
    if (total > MAX_TOTAL) throw new Error("机器人 ZIP 解压大小超限");
    offset = next;
  }
  if (offset !== end) throw new Error("机器人 ZIP 目录范围不一致");
}

export async function readRobotPackage(bytes: ArrayBuffer, definition: RobotAssetDefinition, zipped: boolean, signal?: AbortSignal): Promise<RobotFiles> {
  signal?.throwIfAborted();
  if (bytes.byteLength > (zipped ? ROBOT_IMPORT_LIMITS.compressedBytes : ROBOT_IMPORT_LIMITS.xmlBytes)) throw new Error("机器人资源大小超限");
  const files: RobotFiles = new Map();
  const evidence = new Map(definition.resources.map(item => [item.path, item]));
  if (definition.resources.reduce((total, item) => total + item.size, 0) > MAX_TOTAL) throw new Error("机器人资源清单总大小超限");
  if (zipped) {
    inspectZip(bytes);
    const { default: JSZip } = await import("jszip");
    signal?.throwIfAborted();
    const archive = await JSZip.loadAsync(bytes, { createFolders: false });
    for (const entry of Object.values(archive.files)) {
      signal?.throwIfAborted();
      if (entry.dir) continue;
      const original = (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
      if (original !== entry.name || safeRobotPath(entry.name) !== entry.name) throw new Error("机器人 ZIP 路径不规范");
      const expected = evidence.get(entry.name);
      if (!expected || !Number.isInteger(expected.size) || expected.size < 0 || expected.size > MAX_FILE) throw new Error("机器人 ZIP 文件不在有效清单中");
      files.set(entry.name, await boundedEntry(entry, expected.size, signal));
    }
  } else files.set(safeRobotPath(definition.entryPath), new Uint8Array(bytes));
  if (evidence.size !== definition.resources.length || files.size !== evidence.size) throw new Error("机器人文件包与资源清单不一致");
  for (const [path, data] of files) {
    signal?.throwIfAborted();
    const expected = evidence.get(path);
    if (!expected || data.byteLength !== expected.size || data.byteLength > MAX_FILE) throw new Error(`机器人资源大小校验失败：${path}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    signal?.throwIfAborted();
    const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
    if (actual !== expected.sha256.toLowerCase()) throw new Error(`机器人资源校验失败：${path}`);
  }
  if (!files.has(definition.entryPath)) throw new Error("机器人入口不在资源清单中");
  return files;
}

interface BoundedZipStream {
  on(event: "data", callback: (data: Uint8Array) => void): BoundedZipStream;
  on(event: "error", callback: (error: Error) => void): BoundedZipStream;
  on(event: "end", callback: () => void): BoundedZipStream;
  pause(): void;
  resume(): void;
}
function boundedEntry(entry: JSZip.JSZipObject, maximum: number, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const stream = (entry as JSZip.JSZipObject & { internalStream(type: "uint8array"): BoundedZipStream }).internalStream("uint8array"), chunks: Uint8Array[] = [];
    let length = 0, settled = false;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const fail = (error: unknown) => { if (settled) return; settled = true; stream.pause(); cleanup(); reject(error); };
    const abort = () => fail(signal?.reason ?? new DOMException("已取消", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    stream.on("data", data => {
      if (settled) return;
      length += data.byteLength;
      if (length > maximum) { fail(new Error("机器人 ZIP 实际解压大小超限")); return; }
      chunks.push(data);
    }).on("error", fail).on("end", () => {
      if (settled) return; settled = true; cleanup();
      const result = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      resolve(result);
    }).resume();
  });
}

/** 所有次级加载均只得到本次资源的 Blob URL，不回退网络或跨包查找。 */
export class RobotResourceScope {
  private readonly urls = new Set<string>();
  private readonly byPath = new Map<string, string>();
  private closed = false;
  constructor(readonly files: RobotFiles) {}
  bytes(path: string): Uint8Array<ArrayBuffer> {
    if (this.closed) throw new Error("机器人资源读取已结束");
    const result = this.files.get(safeRobotPath(path));
    if (!result) throw new Error(`机器人文件包缺少资源：${path}`);
    return result;
  }
  own(data: Uint8Array<ArrayBuffer>, type = "application/octet-stream"): string {
    if (this.closed) throw new Error("机器人资源读取已结束");
    const url = URL.createObjectURL(new Blob([data], { type })); this.urls.add(url); return url;
  }
  resolve = (url: string): string => {
    if (this.urls.has(url)) return url;
    if (!url.startsWith(ROBOT_RESOURCE_PREFIX)) throw new Error("机器人资源不允许访问文件包外部");
    const path = safeRobotPath(url.slice(ROBOT_RESOURCE_PREFIX.length));
    let result = this.byPath.get(path);
    if (!result) {
      result = this.own(this.bytes(path), mime(path)); this.byPath.set(path, result);
    }
    return result;
  };
  dispose(): void { this.closed = true; for (const url of this.urls) URL.revokeObjectURL(url); this.urls.clear(); this.byPath.clear(); }
}

function mime(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}
