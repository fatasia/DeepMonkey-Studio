import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { boundedRead, runTextRasterProcess } from "./nativeTextRasterProcess.mjs";
import { TEXT_RASTER_LIMITS as LIMITS, sha256, validateTextRasterRequest, validateTextRasterResult } from "./nativeTextRasterWire.mjs";

/** Frozen-font CPU producer. Evidence records bytes and executable identity, not font licensing. */
export async function rasterizeNativeText({ nativeExecutable, request, signal },
  options = {}) {
  signal?.throwIfAborted();
  const text = JSON.stringify(request);
  if (text === undefined || Buffer.byteLength(text) > LIMITS.requestBytes) throw new Error("Text raster request exceeds 90 MiB");
  const input = JSON.parse(text), faces = validateTextRasterRequest(input);
  const produced = await executeTextJob({ nativeExecutable, request: input, signal }, options);
  const rgba = validateTextRasterResult(produced.result, input, produced.evidence.sourceSha256, faces);
  return { ...produced, rgba };
}

export async function rasterizeNativeTextBatch({ nativeExecutable, requests, signal }, options = {}) {
  signal?.throwIfAborted();
  if (!Array.isArray(requests) || !requests.length || requests.length > 512) throw new Error("Invalid text batch count");
  const shared = JSON.stringify(Object.fromEntries(Object.entries(requests[0]).filter(([key]) => key !== "request")));
  let pixels = 0;
  const inputs = requests.map(request => {
    signal?.throwIfAborted();
    if (JSON.stringify(Object.fromEntries(Object.entries(request).filter(([key]) => key !== "request"))) !== shared)
      throw new Error("Text batch requires identical frozen fonts and locale");
    const faces = validateTextRasterRequest(request), body = JSON.stringify(request.request);
    pixels += request.request.width * request.request.height * 4;
    if (pixels > 64 * 1024 * 1024) throw new Error("Text batch pixels exceed 64 MiB");
    return { request, faces, body, sourceSha256: sha256(Buffer.from(`${shared.slice(0, -1)},"request":${body}}`)) };
  });
  const produced = await executeTextJob({ nativeExecutable, signal, request: { schema: "deep-engine.text-raster-batch",
    schemaVersion: 1, shared, requests: inputs.map(input => input.body) } }, options, "--rasterize-text-batch");
  const batch = produced.result;
  if (batch?.schema !== "deep-engine.text-raster-batch-result" || batch.schemaVersion !== 1
    || Object.keys(batch).sort().join(",") !== "results,schema,schemaVersion"
    || !Array.isArray(batch.results) || batch.results.length !== inputs.length) throw new Error("Invalid text batch result");
  return inputs.map((input, index) => {
    signal?.throwIfAborted();
    const result = batch.results[index], rgba = validateTextRasterResult(result, input.request, input.sourceSha256, input.faces);
    return { result, rgba, evidence: { ...produced.evidence, sourceSha256: input.sourceSha256,
      pixelSha256: result.pixelSha256, producer: result.producer } };
  });
}

async function executeTextJob({ nativeExecutable, request, signal },
  { timeoutMs = 30_000, spawnProcess = spawn, temporaryRoot = tmpdir() } = {}, command = "--rasterize-text") {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Invalid text raster timeout");
  const text = JSON.stringify(request);
  if (text === undefined || Buffer.byteLength(text) > LIMITS.requestBytes) throw new Error("Text raster request exceeds 90 MiB");
  const bytes = Buffer.from(text);
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
    await runTextRasterProcess(spawnProcess, privateExecutable, [command, source, "--output", output], directory, timeoutMs, signal);
    signal?.throwIfAborted();
    if (sha256(await boundedRead(source, LIMITS.requestBytes, signal)) !== sourceSha256
      || sha256(await boundedRead(privateExecutable, LIMITS.executableBytes, signal)) !== executableSha256)
      throw new Error("Native text producer or source changed during execution");
    const resultBytes = await boundedRead(output, command === "--rasterize-text-batch" ? 128 * 1024 * 1024 : LIMITS.resultBytes, signal);
    const result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resultBytes));
    return { result, evidence: { schemaVersion: 1, scope: "native-text-raster", sourceSha256,
      executable, executableSha256, pixelSha256: result.pixelSha256, producer: result.producer } };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
