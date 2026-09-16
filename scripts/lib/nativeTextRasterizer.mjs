import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { boundedRead, runTextRasterProcess } from "./nativeTextRasterProcess.mjs";
import { TEXT_RASTER_LIMITS as LIMITS, sha256, validateTextRasterRequest, validateTextRasterResult } from "./nativeTextRasterWire.mjs";

/** Frozen-font CPU producer. Evidence records bytes and executable identity, not font licensing. */
export async function rasterizeNativeText({ nativeExecutable, request, signal },
  { timeoutMs = 30_000, spawnProcess = spawn, temporaryRoot = tmpdir() } = {}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid text raster timeout");
  const text = JSON.stringify(request);
  if (text === undefined || Buffer.byteLength(text) > LIMITS.requestBytes) throw new Error("Text raster request exceeds 90 MiB");
  const bytes = Buffer.from(text), input = JSON.parse(text), faces = validateTextRasterRequest(input);
  const sourceSha256 = sha256(bytes), executable = path.resolve(nativeExecutable);
  const executableBytes = await boundedRead(executable, LIMITS.executableBytes, signal);
  const executableSha256 = sha256(executableBytes);
  const directory = await mkdtemp(path.join(temporaryRoot, "deep-native-text-"));
  try {
    await chmod(directory, 0o700);
    const privateExecutable = path.join(directory, process.platform === "win32" ? "producer.exe" : "producer");
    const source = path.join(directory, "request.json"), output = path.join(directory, "result.json");
    await writeFile(privateExecutable, executableBytes, { flag: "wx", mode: 0o500 });
    await writeFile(source, bytes, { flag: "wx", mode: 0o400 });
    signal?.throwIfAborted();
    await runTextRasterProcess(spawnProcess, privateExecutable, ["--rasterize-text", source, "--output", output], directory, timeoutMs, signal);
    signal?.throwIfAborted();
    if (sha256(await boundedRead(source, LIMITS.requestBytes, signal)) !== sourceSha256
      || sha256(await boundedRead(privateExecutable, LIMITS.executableBytes, signal)) !== executableSha256)
      throw new Error("Native text producer or source changed during execution");
    const resultBytes = await boundedRead(output, LIMITS.resultBytes, signal);
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resultBytes));
    const rgba = validateTextRasterResult(result, input, sourceSha256, faces);
    return { result, rgba, evidence: { schemaVersion: 1, scope: "native-text-raster", sourceSha256,
      executable, executableSha256, pixelSha256: result.pixelSha256, producer: result.producer } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
