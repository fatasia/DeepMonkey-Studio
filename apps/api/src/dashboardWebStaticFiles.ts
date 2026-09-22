import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DASHBOARD_WEB_FILE_LIMIT, DASHBOARD_WEB_TOTAL_LIMIT } from "@bim-studio/contracts";

export type DashboardPackagedFile = { readonly path: string; readonly bytes: Uint8Array; readonly sha256: string };

/** 同一文件句柄固定容量读取，拒绝读取期间增长、截断或修改。 */
export async function readDashboardStaticFile(file: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error("静态包文件超出预算或不是普通文件");
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      signal?.throwIfAborted();
      const chunk = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!chunk.bytesRead) throw new Error("静态包文件在读取期间改变");
      offset += chunk.bytesRead;
    }
    signal?.throwIfAborted();
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat();
    if (extra.bytesRead || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("静态包文件在读取期间改变");
    return bytes;
  } finally { await handle.close(); }
}

/** 运行时文件必须留在物理包根内；链接/联接点拒绝，不能静默漏包。 */
export async function collectDashboardStaticFiles(root: string, signal?: AbortSignal): Promise<DashboardPackagedFile[]> {
  const directory = await realpath(root), files: DashboardPackagedFile[] = [];
  let total = 0;
  const walk = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = path.posix.join(relative, entry.name);
      if (!relative && (name === "licenses" || name === "dashboard.web.json")) continue;
      const file = path.join(directory, name), info = await lstat(file);
      const resolved = await realpath(file), child = path.relative(directory, resolved);
      if (info.isSymbolicLink() || child.startsWith(`..${path.sep}`) || child === ".." || path.isAbsolute(child))
        throw new Error(`静态包文件越界或使用链接：${name}`);
      if (info.isDirectory()) { await walk(name); continue; }
      if (!info.isFile()) throw new Error(`静态包包含非普通文件：${name}`);
      if ((total += info.size) > DASHBOARD_WEB_TOTAL_LIMIT) throw new Error("静态包运行时总字节预算超限");
      const bytes = await readDashboardStaticFile(file, Math.min(info.size, DASHBOARD_WEB_FILE_LIMIT), signal);
      files.push({ path: name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  };
  await walk("");
  return files;
}
