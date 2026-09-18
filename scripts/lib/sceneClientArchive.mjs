import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import { validateSceneClientArchivePaths } from "../../apps/web/src/delivery/sceneClientPackageIndex.ts";
import { validateSceneClientArchiveManifest } from "./sceneClientArchiveManifest.mjs";
import { validateSceneClientArchiveNative } from "./sceneClientArchiveNative.mjs";

export const sceneClientArchiveLimits = Object.freeze({
  archiveBytes: 512 * 1024 ** 2, manifestBytes: 1024 ** 2,
  fileBytes: 256 * 1024 ** 2, totalBytes: 1024 ** 3, entries: 10_000, nativeMetadataBytes: 64 * 1024 ** 2,
});
function check(condition, message) { if (!condition) throw new Error(`客户端包校验失败：${message}`); }

/** 只读验证，不解压到磁盘、不运行包内内容；返回值不是 Native 运行能力证明。 */
export async function verifySceneClientArchive(buffer, { expectedTarget, limits: overrides = {}, signal } = {}) {
  signal?.throwIfAborted();
  const limits = { ...sceneClientArchiveLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    check(Object.hasOwn(sceneClientArchiveLimits, name) && Number.isSafeInteger(value) && value > 0, `限额无效：${name}`);
  }
  check(Buffer.isBuffer(buffer) || buffer instanceof Uint8Array, "输入必须是 ZIP 字节");
  check(buffer.byteLength <= limits.archiveBytes, "archiveBytes 超限");
  // 首次 await 前复制，调用方后续修改输入不会改变本次校验对象。
  const snapshot = Buffer.from(buffer);
  const zip = await yauzl.fromBufferPromise(snapshot, { strictFileNames: true, validateEntrySizes: true, autoClose: false });
  try {
    check(zip.entryCount <= limits.entries, "entries 超限");
    const entries = await readEntries(zip, snapshot, limits, signal);
    const manifestEntry = entries.find(entry => entry.fileName === "manifest.json");
    check(manifestEntry && !manifestEntry.fileName.endsWith("/"), "缺少 manifest.json");
    const manifestRead = await readContent(zip, manifestEntry, limits.manifestBytes, signal, true);
    const manifest = validateSceneClientArchiveManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestRead.content)), { expectedTarget });
    const files = entries.filter(entry => !entry.fileName.endsWith("/") && entry !== manifestEntry);
    const byPath = new Map(files.map(entry => [entry.fileName, entry]));
    check(files.length === manifest.files.length && manifest.files.every(file => byPath.has(file.path)), "实际文件集合与清单不一致");
    let totalBytes = manifestRead.bytes;
    const nativeContents = new Map();
    const nativePaths = manifest.target === "deep-native"
      ? new Set(["scene.json", "project.json", "native/runtime-package.json", "native/compilation-evidence.json", "native/compatibility-report.json"])
      : new Set();
    for (const file of manifest.files) {
      signal?.throwIfAborted();
      const entry = byPath.get(file.path);
      check(entry.uncompressedSize === file.bytes, `文件大小不匹配：${file.path}`);
      const collect = nativePaths.has(file.path);
      const metadataCap = collect && file.path !== "native/runtime-package.json" ? limits.nativeMetadataBytes : limits.fileBytes;
      check(entry.uncompressedSize <= metadataCap, `Native 元数据读取限额超限：${file.path}`);
      const result = await readContent(zip, entry, Math.min(metadataCap, limits.totalBytes - totalBytes), signal, collect);
      check(result.sha256 === file.sha256, `SHA-256 不匹配：${file.path}`);
      if (collect) nativeContents.set(file.path, result.content);
      totalBytes += result.bytes;
    }
    signal?.throwIfAborted();
    if (manifest.target === "deep-native") validateSceneClientArchiveNative(manifest, nativeContents);
    return { manifest, fileCount: files.length, totalBytes };
  } finally { zip.close(); }
}

async function readEntries(zip, snapshot, limits, signal) {
  const entries = [], names = new Set(), ranges = [];
  let totalBytes = 0;
  for await (const entry of zip.eachEntry()) {
    signal?.throwIfAborted();
    check(entries.length < limits.entries, "entries 超限");
    const directory = entry.fileName.endsWith("/");
    const path = directory ? entry.fileName.slice(0, -1) : entry.fileName;
    if (path !== "manifest.json") validateSceneClientArchivePaths([path]);
    else check(!directory, "manifest.json 不能是目录");
    check(!names.has(path.toLowerCase()), `路径重复或大小写冲突：${path}`);
    names.add(path.toLowerCase());
    const type = (entry.externalFileAttributes >>> 16) & 0xf000;
    check(type === 0 || type === (directory ? 0x4000 : 0x8000), `不支持特殊文件：${path}`);
    check(!(entry.generalPurposeBitFlag & 1) && [0, 8].includes(entry.compressionMethod), `加密或压缩方法不支持：${path}`);
    check(!directory || (entry.uncompressedSize === 0 && entry.crc32 === 0), `目录含有负载或 CRC 无效：${path}`);
    const cap = path === "manifest.json" ? limits.manifestBytes : limits.fileBytes;
    check(Number.isSafeInteger(entry.uncompressedSize) && entry.uncompressedSize >= 0 && entry.uncompressedSize <= cap, `文件读取限额超限：${path}`);
    totalBytes += entry.uncompressedSize;
    check(totalBytes <= limits.totalBytes, "totalBytes 超限");
    const local = await zip.readLocalFileHeaderPromise(entry);
    const localName = yauzl.getFileNameLowLevel(local.generalPurposeBitFlag, local.fileName, yauzl.parseExtraFields(local.extraField), true);
    check(localName === entry.fileName && local.fileName.equals(entry.fileNameRaw)
      && local.compressionMethod === entry.compressionMethod && local.generalPurposeBitFlag === entry.generalPurposeBitFlag,
    `本地与中央目录不一致：${path}`);
    if (!(entry.generalPurposeBitFlag & 8)) {
      check(local.crc32 === entry.crc32, `CRC 头不一致：${path}`);
      // ZIP64 大小由中央目录扩展字段解析；普通大小必须双头一致。
      check((local.compressedSize === 0xffffffff || local.compressedSize === entry.compressedSize)
        && (local.uncompressedSize === 0xffffffff || local.uncompressedSize === entry.uncompressedSize), `大小头不一致：${path}`);
    }
    const dataEnd = local.fileDataStart + entry.compressedSize;
    ranges.push([entry.relativeOffsetOfLocalHeader, descriptorEnd(snapshot, entry, dataEnd)]);
    entries.push(entry);
  }
  const files = entries.filter(entry => !entry.fileName.endsWith("/")).map(entry => entry.fileName);
  validateSceneClientArchivePaths(files.filter(path => path !== "manifest.json"));
  for (const entry of entries.filter(entry => entry.fileName.endsWith("/"))) {
    check(files.some(path => path.startsWith(entry.fileName)), `无负载的目录：${entry.fileName}`);
    check(!files.some(path => entry.fileName.toLowerCase().startsWith(`${path.toLowerCase()}/`)), `文件与目录冲突：${entry.fileName}`);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  check(ranges.every((range, index) => index === 0 || ranges[index - 1][1] <= range[0]), "ZIP 文件区间重叠");
  return entries;
}

function descriptorEnd(buffer, entry, offset) {
  if (!(entry.generalPurposeBitFlag & 8)) return offset;
  // 当前导出不使用 ZIP64；流式 ZIP64 的 64 位 descriptor 需单独适配。
  check(entry.versionNeededToExtract < 45, "不支持 ZIP64 data descriptor");
  const signed = offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x08074b50;
  const start = offset + (signed ? 4 : 0);
  check(start + 12 <= buffer.length && buffer.readUInt32LE(start) === entry.crc32
    && buffer.readUInt32LE(start + 4) === entry.compressedSize
    && buffer.readUInt32LE(start + 8) === entry.uncompressedSize, `data descriptor 不匹配：${entry.fileName}`);
  return start + 12;
}

async function readContent(zip, entry, cap, signal, collect = false) {
  signal?.throwIfAborted();
  const stream = await zip.openReadStreamPromise(entry);
  const abort = () => stream.destroy(signal.reason instanceof Error ? signal.reason : new Error("校验已取消"));
  signal?.addEventListener("abort", abort, { once: true });
  const hash = createHash("sha256"), chunks = [];
  let bytes = 0, crc = 0;
  try {
    signal?.throwIfAborted();
    for await (const chunk of stream) {
      signal?.throwIfAborted();
      bytes += chunk.length;
      check(bytes <= cap, `文件读取限额超限：${entry.fileName}`);
      hash.update(chunk); crc = crc32(chunk, crc);
      if (collect) chunks.push(chunk);
    }
    check(bytes === entry.uncompressedSize && crc === entry.crc32, `大小或 CRC 不匹配：${entry.fileName}`);
    return { bytes, sha256: hash.digest("hex"), content: collect ? Buffer.concat(chunks, bytes) : undefined };
  } finally {
    signal?.removeEventListener("abort", abort);
    stream.destroy();
  }
}
