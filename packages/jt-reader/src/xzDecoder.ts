import xzDecompress from "xz-decompress";

import { JtFormatError } from "./binaryReader.js";

// xz-decompress 发布的是 CommonJS UMD 包。使用默认导入可同时兼容 Node ESM 与 Vite，
// 避免 Node 24 将命名导入误判为不存在的运行时导出。
const { XzReadableStream } = xzDecompress as typeof import("xz-decompress");

async function collectBounded(
  output: ReadableStreamDefaultReader<Uint8Array>,
  maxOutputBytes: number,
  format: string,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await output.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxOutputBytes) {
        await output.cancel(`${format} 解压结果超过安全上限`);
        throw new JtFormatError(`JT 解压结果超过 ${maxOutputBytes} 字节上限`);
      }
      chunks.push(result.value);
    }
  } finally {
    output.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * 使用纯 WASM 的 XZ 解压器。这里主动逐块读取并限制输出，避免异常 JT 文件造成内存失控。
 */
export async function decompressXz(compressed: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  // Uint8Array 可能包装 SharedArrayBuffer；复制后交给 Blob，兼容严格 DOM 类型并隔离调用方变更。
  const inputBytes = new Uint8Array(compressed.byteLength);
  inputBytes.set(compressed);
  const input = new Blob([inputBytes.buffer]).stream();
  const output = new XzReadableStream(input).getReader();

  try {
    return await collectBounded(output, maxOutputBytes, "XZ");
  } catch (error) {
    if (error instanceof JtFormatError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new JtFormatError(`JT XZ 数据解压失败：${reason}`);
  }
}

/** JT 9.x 的可压缩段使用标准 zlib/deflate 流，Web 与 Node 均由平台流式解压。 */
export async function decompressDeflate(compressed: Uint8Array, maxOutputBytes: number): Promise<Uint8Array> {
  const inputBytes = new Uint8Array(compressed.byteLength);
  inputBytes.set(compressed);
  try {
    const stream = new Blob([inputBytes.buffer])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    return await collectBounded(stream.getReader(), maxOutputBytes, "Deflate");
  } catch (error) {
    if (error instanceof JtFormatError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new JtFormatError(`JT Deflate 数据解压失败：${reason}`);
  }
}
