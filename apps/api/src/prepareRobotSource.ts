import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import JSZip from "jszip";
import type { RobotAssetDefinition, RobotResourceEvidence } from "@bim-studio/contracts";
import { MAX_ROBOT_XML_BYTES, parseRobotUrdf } from "./parseRobotUrdf.js";
import { robotArchivePath } from "./robotUrdfValues.js";
import { inspectRobotZipDirectory, ROBOT_PACKAGE_LIMITS, robotResourceCrc32 } from "./robotZipDirectory.js";

export async function prepareRobotSource(sourcePath: string, options: { entryPath?: string } = {}): Promise<RobotAssetDefinition> {
  const info = await stat(sourcePath);
  const zipped = path.extname(sourcePath).toLowerCase() === ".zip";
  if (info.size > (zipped ? ROBOT_PACKAGE_LIMITS.archiveBytes : MAX_ROBOT_XML_BYTES)) throw new Error("机器人描述文件超过大小限制");
  const bytes = await readFile(sourcePath);
  if (!zipped) {
    const entryPath = robotArchivePath(path.basename(sourcePath));
    if (options.entryPath && options.entryPath !== entryPath) throw new Error("单 URDF 文件的入口名称不匹配");
    const definition = parseRobotUrdf(decodeXml(bytes), { entryPath, availableFiles: new Set([entryPath]) });
    definition.resources = [evidence(entryPath, bytes)];
    return definition;
  }
  const entries = inspectRobotZipDirectory(bytes);
  const paths = new Set(entries.filter(entry => !entry.directory).map(entry => entry.name));
  const candidates = [...paths].filter(name => /\.urdf$/i.test(name));
  const entryPath = options.entryPath ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!entryPath || !candidates.includes(entryPath)) throw new Error(candidates.length > 1 ? `机器人包包含多个 URDF，请选择入口：${candidates.join("、")}` : "机器人 ZIP 缺少有效 URDF 入口");
  const zip = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: false });
  if (Object.keys(zip.files).length !== entries.length) throw new Error("机器人 ZIP 存在重复或变更条目");
  const resources: RobotResourceEvidence[] = [];
  let xml = "";
  for (const entry of entries) {
    const file = zip.files[entry.name];
    if (!file || file.dir !== entry.directory || ((file as typeof file & { unsafeOriginalName?: string }).unsafeOriginalName ?? file.name) !== entry.name) throw new Error("机器人 ZIP 路径被解析器改写");
    if (entry.directory) continue;
    const limit = /\.urdf$/i.test(entry.name) ? MAX_ROBOT_XML_BYTES : ROBOT_PACKAGE_LIMITS.fileBytes;
    if (entry.size > limit) throw new Error(`机器人文件过大：${entry.name}`);
    // 不启用 JSZip 的全包预解压 CRC；逐文件流限制实际膨胀，再校验长度/CRC。
    const content = await boundedEntry(file, Math.min(limit, entry.size));
    if (content.length !== entry.size || robotResourceCrc32(content) !== entry.crc32) throw new Error(`机器人文件校验失败：${entry.name}`);
    resources.push(evidence(entry.name, content));
    if (entry.name === entryPath) xml = decodeXml(content);
  }
  const definition = parseRobotUrdf(xml, { entryPath, availableFiles: paths });
  definition.resources = resources;
  return definition;
}

function boundedEntry(entry: JSZip.JSZipObject, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stream = entry.nodeStream("nodebuffer") as Readable;
    const chunks: Buffer[] = [];
    let length = 0;
    stream.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > maximum) { stream.destroy(new Error("机器人 ZIP 实际解压大小超限")); return; }
      chunks.push(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks, length)));
  });
}
function evidence(resourcePath: string, bytes: Buffer): RobotResourceEvidence {
  return { path: resourcePath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
function decodeXml(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("URDF 必须使用 UTF-8 编码"); }
}
