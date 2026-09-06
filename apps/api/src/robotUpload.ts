import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ROBOT_IMPORT_LIMITS } from "@bim-studio/contracts";

export class RobotUploadLimitError extends Error {}

/** 限制上传阶段落盘体积；解压/格式检查仍由 Provider 权威执行。 */
export async function writeRobotUpload(stream: Readable, sourcePath: string, format: "urdf" | "zip"): Promise<void> {
  const maximum = format === "urdf" ? ROBOT_IMPORT_LIMITS.xmlBytes : ROBOT_IMPORT_LIMITS.compressedBytes;
  let bytes = 0;
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    callback(bytes > maximum ? new RobotUploadLimitError(`机器人文件超过 ${maximum / 1024 / 1024} MiB`) : null, chunk);
  } });
  const target = createWriteStream(sourcePath, { flags: "wx" });
  let created = false;
  target.once("open", () => { created = true; });
  try { await pipeline(stream, limit, target); }
  catch (reason) { if (created) await rm(sourcePath, { force: true }); throw reason; }
}
