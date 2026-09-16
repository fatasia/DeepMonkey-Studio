import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";

export async function boundedRead(file, limit, signal) {
  signal?.throwIfAborted();
  if (!(await lstat(file)).isFile()) throw new Error("Text producer input/output must be a regular file");
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > limit) throw new Error("Text producer file exceeds byte budget");
    const chunks = []; let length = 0;
    while (true) {
      signal?.throwIfAborted();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, limit + 1 - length));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > limit) throw new Error("Text producer file exceeds byte budget");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, length);
  } finally { await handle.close(); }
}

/** Settle only after close, so private files cannot be removed under a live producer. */
export async function runTextRasterProcess(spawnProcess, executable, args, directory, timeoutMs, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = spawnProcess(executable, args, { cwd: directory, shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    let failure, diagnosticBytes = 0, diagnostic = "", hardKill;
    const stop = error => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      hardKill = setTimeout(() => child.kill("SIGKILL"), 250);
    };
    const timer = setTimeout(() => stop(new Error("Native text rasterizer timed out")), timeoutMs);
    const abort = () => stop(signal.reason instanceof Error ? signal.reason : new Error("Native text rasterizer aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const receive = chunk => {
      diagnosticBytes += chunk.length;
      if (diagnosticBytes > 16 * 1024) { stop(new Error("Native text diagnostics exceed 16 KiB")); return; }
      diagnostic += chunk.toString("utf8");
    };
    child.stdout.on("data", receive); child.stderr.on("data", receive);
    child.once("error", error => { failure ??= error; });
    child.once("close", (code, termination) => {
      clearTimeout(timer); clearTimeout(hardKill); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Native text rasterizer exited ${termination ?? code}: ${diagnostic.trim()}`));
      else resolve();
    });
  });
}
