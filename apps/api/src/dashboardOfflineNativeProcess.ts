import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDashboardOfflineNativeLaunchPlan } from "./dashboardOfflineNativeLauncher.js";

/** 从已校验的同一份字节启动本地播放器，进程关闭后清理运行包。 */
export async function runDashboardOfflineNative(
  archiveBytes: Uint8Array,
  nativeExecutable: string,
  options: { signal?: AbortSignal; spawnProcess?: typeof spawn } = {},
): Promise<{ status: "closed"; code: 0; targetArtifactHash: string }> {
  options.signal?.throwIfAborted();
  const plan = createDashboardOfflineNativeLaunchPlan(archiveBytes);
  if (!nativeExecutable || !path.isAbsolute(nativeExecutable)) throw new Error("Native executable must be an absolute local path");
  if (!(await stat(nativeExecutable)).isFile()) throw new Error("Native executable must be a file");
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), "deep-dashboard-client-"));
  try {
    const packagePath = path.join(directory, "runtime-package.json");
    await writeFile(packagePath, plan.artifact, { flag: "wx", mode: 0o600 });
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = (options.spawnProcess ?? spawn)(nativeExecutable, ["--package", packagePath], {
        cwd: directory, shell: false, windowsHide: true, stdio: "inherit",
      });
      let failed = false;
      let failure: unknown;
      const cancel = () => {
        failed = true;
        failure = options.signal?.reason ?? new DOMException("Aborted", "AbortError");
        child.kill();
      };
      child.once("error", reason => { failed = true; failure = reason; });
      // error/exit 后文件仍可能在被读取，必须等 stdio 关闭。
      child.once("close", (code, signal) => {
        options.signal?.removeEventListener("abort", cancel);
        if (failed) reject(failure);
        else if (code !== 0) reject(new Error(`Native Dashboard exited: ${signal ?? code}`));
        else resolve();
      });
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
    });
    return { status: "closed", code: 0, targetArtifactHash: plan.targetArtifactHash };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
