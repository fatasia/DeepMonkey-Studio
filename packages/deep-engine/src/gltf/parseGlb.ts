import { MAX_BYTES, budget, integer, invalid, list, object, unsupported } from "./validation.js";

export interface ParsedGlb {
  readonly json: unknown;
  readonly buffers: readonly Uint8Array[];
}

/** 解析 GLB 2.0 容器，不读取文件、网络或解码图像。buffer 视图与输入共享字节；需要长期持有的消费者必须复制。 */
export function parseGlb(bytes: Uint8Array): ParsedGlb {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 20) invalid("glb", "Truncated GLB header or JSON chunk.");
  budget(bytes.byteLength, MAX_BYTES, "glb");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) invalid("glb.magic", "Expected glTF magic.");
  if (view.getUint32(4, true) !== 2) unsupported("glb.version", "GLB versions other than 2");
  if (view.getUint32(8, true) !== bytes.byteLength) invalid("glb.length", "Declared and actual GLB lengths differ.");

  let cursor = 12;
  let json: unknown;
  let binary: Uint8Array | undefined;
  let chunks = 0;
  while (cursor < bytes.byteLength) {
    const path = `glb.chunks[${chunks}]`;
    if (cursor + 8 > bytes.byteLength) invalid(path, "Truncated chunk header.");
    const length = view.getUint32(cursor, true), type = view.getUint32(cursor + 4, true);
    cursor += 8;
    if (length % 4 || cursor + length > bytes.byteLength) invalid(path, "Chunk length is unaligned or out of bounds.");
    const payload = bytes.subarray(cursor, cursor + length);
    if (chunks === 0 && type !== 0x4e4f534a) invalid(path, "JSON must be the first chunk.");
    if (type === 0x4e4f534a) {
      if (chunks !== 0) invalid(path, "Duplicate or misplaced JSON chunk.");
      try {
        json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
      } catch {
        invalid(path, "Invalid UTF-8 or JSON payload.");
      }
    } else if (type === 0x004e4942) {
      if (binary !== undefined || chunks !== 1) invalid(path, "Duplicate or misplaced BIN chunk.");
      binary = payload;
    }
    // glTF 2.0 要求忽略未知附加 chunk；需要其内容的扩展仍由文档检查明确拒绝。
    cursor += length;
    chunks++;
  }

  const document = object(json, "$"), buffers = list(document.buffers, "buffers");
  if (binary === undefined) {
    if (buffers.length) unsupported("buffers", "external GLB buffers");
    return { json: document, buffers: [] };
  }
  if (buffers.length !== 1) unsupported("buffers", "multi-buffer GLB");
  const buffer = object(buffers[0], "buffers[0]");
  if (buffer.uri !== undefined) invalid("buffers[0].uri", "Embedded BIN buffer cannot have a URI.");
  const length = integer(buffer.byteLength, "buffers[0].byteLength", 1);
  if (length > binary.byteLength || binary.byteLength - length > 3) invalid("glb.bin", "BIN size must match declared buffer length plus up to three padding bytes.");
  if (binary.subarray(length).some(value => value !== 0)) invalid("glb.bin", "BIN padding must contain zero bytes.");
  return { json: document, buffers: [binary] };
}
