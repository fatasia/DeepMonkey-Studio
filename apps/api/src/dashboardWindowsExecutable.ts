import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export async function readDashboardWindowsExecutable(file: string, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".exe") throw new Error("Native executable must be an absolute .exe path");
  const info = await stat(file);
  if (!info.isFile() || info.size > 512 * 1024 * 1024) throw new Error("Native executable must be a file under 512 MiB");
  const bytes = await readFile(file, { signal });
  if (bytes.length > 512 * 1024 * 1024) throw new Error("Native executable exceeds 512 MiB");
  if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Native executable is not a Windows PE file");
  const offset = bytes.readUInt32LE(0x3c);
  if (offset < 64 || offset > bytes.length - 24 || bytes.readUInt32LE(offset) !== 0x00004550) throw new Error("Native executable has an invalid PE header");
  if ((bytes.readUInt16LE(offset + 22) & 0x2000) !== 0) throw new Error("Native executable cannot be a DLL");
  signal?.throwIfAborted();
  return bytes;
}
