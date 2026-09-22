import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ConversionTaskRecord } from "@bim-studio/contracts";
import type { ObjectStore } from "./objects.js";

/** 本地缓存丢失时从既有对象存储恢复；只有大小、摘要均匹配的源字节才能进入解析器。 */
export async function verifyConversionSource(objects: ObjectStore, task: ConversionTaskRecord, filePath: string, signal: AbortSignal): Promise<void> {
  try { await stat(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await restore(objects, task, filePath, signal);
  }
  signal.throwIfAborted();
  await verify(filePath, task, signal);
}

async function restore(objects: ObjectStore, task: ConversionTaskRecord, destination: string, signal: AbortSignal): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(path.dirname(destination), `.restore-${task.id}`);
  let bytes = 0;
  try {
    signal.throwIfAborted();
    const source = await objects.read(task.input.objectKey);
    const meter = new Transform({ transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      done(bytes > task.input.size ? new Error("源对象超过声明大小") : undefined, chunk);
    } });
    const pumping = pipeline(source.stream, meter, createWriteStream(temporary, { flags: "wx" }), { signal });
    try { await Promise.all([pumping, source.completed]); }
    catch (error) {
      source.stream.destroy(error instanceof Error ? error : new Error(String(error)));
      await Promise.allSettled([pumping, source.completed]);
      throw error;
    }
    await verify(temporary, task, signal);
    signal.throwIfAborted();
    // 原子、不得覆盖：另一个恢复者已创建缓存时，调用方重新核验已存在文件。
    try { await link(temporary, destination); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await rm(temporary, { force: true }); }
}

async function verify(file: string, task: ConversionTaskRecord, signal: AbortSignal): Promise<void> {
  if ((await stat(file)).size !== task.input.size) throw new Error("源文件大小已变化");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) digest.update(chunk);
  if (digest.digest("hex") !== task.input.sha256) throw new Error("源文件 SHA-256 已变化");
}
