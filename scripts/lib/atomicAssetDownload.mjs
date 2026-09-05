import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export class AssetValidationError extends Error {}

/** A response never reaches the final file until its bytes and content are verified. */
export async function downloadAssetAtomically(url, targetPath, options) {
  const { maxBytes, validate, fetcher = fetch, attempts = 3, timeoutMs = 90_000 } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || typeof validate !== "function") throw new Error("下载必须声明字节上限及格式校验器");
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error("下载尝试次数必须在1至5之间");
  const source = new URL(url);
  if (!["https:", "http:"].includes(source.protocol) || source.username || source.password) throw new Error("下载地址必须为无用户凭据的HTTP(S)地址");
  const target = path.resolve(targetPath);
  if (target === path.parse(target).root) throw new Error("下载目标必须是文件");
  await mkdir(path.dirname(target), { recursive: true });
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const temporary = `${target}.${randomUUID()}.part`;
    let bytes = 0;
    try {
      const response = await fetcher(source, { headers: { "User-Agent": "BimStudioAssetSync/2.0" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`下载失败：HTTP ${response.status}`); }
      if (!response.body) throw new AssetValidationError("下载响应没有文件内容");
      const length = response.headers.get("content-length");
      const declaredBytes = length !== null && /^\d+$/.test(length) ? Number(length) : undefined;
      if (declaredBytes !== undefined && declaredBytes > maxBytes) { await response.body.cancel(); throw new AssetValidationError("文件声明大小超出下载上限"); }
      const limiter = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new AssetValidationError("文件实际大小超出下载上限") : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(temporary, { flags: "wx" }));
      if (!bytes) throw new AssetValidationError("下载文件为空");
      // Fetch transparently decodes transfer content; compare length only for identity encoding.
      if (declaredBytes !== undefined && !response.headers.get("content-encoding") && declaredBytes !== bytes) throw new AssetValidationError("文件实际大小与响应声明不一致");
      const inspection = await validate(temporary, bytes);
      if (inspection?.valid === false) throw new AssetValidationError(inspection.reason || "下载文件未通过内容校验");
      const resultBytes = (await stat(temporary)).size;
      if (!resultBytes || resultBytes > maxBytes) throw new AssetValidationError("验证后的文件大小无效");
      await rename(temporary, target);
      return { bytes: resultBytes, inspection };
    } catch (error) {
      // Only this invocation's unique temporary file is eligible for cleanup.
      await unlink(temporary).catch(reason => { if (reason.code !== "ENOENT") throw reason; });
      if (error instanceof AssetValidationError || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 500));
    }
  }
  throw new Error("下载尝试次数无效");
}
