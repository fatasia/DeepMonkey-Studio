import { robotArchivePath } from "./robotUrdfValues.js";
import { ROBOT_IMPORT_LIMITS } from "@bim-studio/contracts";

export const ROBOT_PACKAGE_LIMITS = { archiveBytes: ROBOT_IMPORT_LIMITS.compressedBytes, fileBytes: ROBOT_IMPORT_LIMITS.entryBytes, expandedBytes: ROBOT_IMPORT_LIMITS.expandedBytes, entries: ROBOT_IMPORT_LIMITS.maxEntries } as const;
export interface RobotZipEntry { name: string; directory: boolean; size: number; compressedSize: number; crc32: number }

/** 在 JSZip 合并/净化条目名之前检查中央目录；不实现解压，不接受 ZIP64/多卷。 */
export function inspectRobotZipDirectory(bytes: Buffer): RobotZipEntry[] {
  if (bytes.length > ROBOT_PACKAGE_LIMITS.archiveBytes) throw new Error("机器人 ZIP 超过 128 MiB");
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw new Error("机器人 ZIP 目录无效");
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 65535 || start === 0xffffffff || size === 0xffffffff) throw new Error("机器人包暂不支持 ZIP64 或多卷 ZIP");
  if (!count || count > ROBOT_PACKAGE_LIMITS.entries || start + size !== end) throw new Error("机器人 ZIP 文件数或目录范围无效");
  const entries: RobotZipEntry[] = [], names = new Set<string>();
  const ranges: Array<[number, number]> = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = start, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("机器人 ZIP 中央目录损坏");
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20), entrySize = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28), extraSize = bytes.readUInt16LE(offset + 30), commentSize = bytes.readUInt16LE(offset + 32);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > end || flags & 1 || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34)) throw new Error("机器人 ZIP 条目编码或压缩方式不支持");
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameSize);
    rejectZip64Extra(bytes, offset + 46 + nameSize, extraSize);
    const entryName = decoder.decode(rawName), directory = entryName.endsWith("/");
    const safeName = robotArchivePath(directory ? entryName.slice(0, -1) : entryName);
    const key = safeName.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error(`机器人 ZIP 路径重复：${safeName}`);
    names.add(key);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16;
    if ((mode & 0xf000) !== 0 && (mode & 0xf000) !== (directory ? 0x4000 : 0x8000)) throw new Error("机器人 ZIP 不允许符号链接或特殊文件");
    if (entrySize > ROBOT_PACKAGE_LIMITS.fileBytes || compressedSize === 0xffffffff || entrySize === 0xffffffff || (entrySize > 1024 * 1024 && entrySize > Math.max(compressedSize, 1) * 200)) throw new Error("机器人 ZIP 单文件大小或压缩比例超限");
    expanded += entrySize;
    if (expanded > ROBOT_PACKAGE_LIMITS.expandedBytes) throw new Error("机器人 ZIP 解压后超过 256 MiB");
    const local = bytes.readUInt32LE(offset + 42);
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) throw new Error("机器人 ZIP 本地条目无效");
    const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28);
    if (local + 30 + localNameSize + localExtraSize + compressedSize > start || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method ||
      !bytes.subarray(local + 30, local + 30 + localNameSize).equals(rawName)) throw new Error("机器人 ZIP 条目清单与内容不一致");
    rejectZip64Extra(bytes, local + 30 + localNameSize, localExtraSize);
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== bytes.readUInt32LE(offset + 16) || bytes.readUInt32LE(local + 18) !== compressedSize || bytes.readUInt32LE(local + 22) !== entrySize)) throw new Error("机器人 ZIP 条目长度或 CRC 清单不一致");
    ranges.push([local, local + 30 + localNameSize + localExtraSize + compressedSize]);
    entries.push({ name: entryName, directory, size: entrySize, compressedSize, crc32: bytes.readUInt32LE(offset + 16) });
    offset = next;
  }
  if (offset !== end) throw new Error("机器人 ZIP 包含未声明目录数据");
  ranges.sort((left, right) => left[0] - right[0]);
  if (ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1]![1])) throw new Error("机器人 ZIP 条目范围重叠");
  return entries;
}

function rejectZip64Extra(bytes: Buffer, start: number, size: number): void {
  const end = start + size;
  for (let offset = start; offset < end;) {
    if (offset + 4 > end) throw new Error("机器人 ZIP 扩展数据损坏");
    const kind = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2);
    if (kind === 1) throw new Error("机器人包暂不支持 ZIP64");
    offset += 4 + length;
    if (offset > end) throw new Error("机器人 ZIP 扩展数据越界");
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit++) current = current & 1 ? 0xedb88320 ^ current >>> 1 : current >>> 1;
  return current >>> 0;
});
export function robotResourceCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
