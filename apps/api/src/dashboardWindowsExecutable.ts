import { open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export async function readDashboardWindowsExecutable(file: string, signal?: AbortSignal, expectedSha256?: string): Promise<Buffer> {
  signal?.throwIfAborted();
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Invalid expected Native executable SHA-256");
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".exe") throw new Error("Native executable must be an absolute .exe path");
  const bytes = await readExecutableSnapshot(file, signal);
  return validateDashboardWindowsExecutable(bytes, expectedSha256, signal);
}

export function validateDashboardWindowsExecutable(input: Uint8Array, expectedSha256?: string, signal?: AbortSignal): Buffer {
  signal?.throwIfAborted();
  if (expectedSha256 !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error("Invalid expected Native executable SHA-256");
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (expectedSha256 !== undefined && createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new Error("Native executable changed since deployment");
  if (bytes.length > 512 * 1024 * 1024) throw new Error("Native executable exceeds 512 MiB");
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Native executable is not a Windows PE file");
  const offset = bytes.readUInt32LE(0x3c);
  if (offset < 64 || offset > bytes.length - 24 || bytes.readUInt32LE(offset) !== 0x00004550) throw new Error("Native executable has an invalid PE header");
  if ((bytes.readUInt16LE(offset + 22) & 0x2000) !== 0) throw new Error("Native executable cannot be a DLL");
  signal?.throwIfAborted();
  return bytes;
}

async function readExecutableSnapshot(file: string, signal?: AbortSignal): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    signal?.throwIfAborted();
    const info = await handle.stat();
    if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new Error("Native executable must be a file under 512 MiB");
    // 固定分配上限，文件增长不能触发 readFile 的继续扩容。
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (bytesRead === 0) throw new Error("Native executable changed during read");
      offset += bytesRead;
    }
    signal?.throwIfAborted();
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await handle.stat();
    if (extra.bytesRead !== 0 || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new Error("Native executable changed during read");
    }
    return bytes;
  } finally { await handle.close(); }
}
