import { readFile, mkdir, open, unlink, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setImmediate as yieldToNode } from "node:timers/promises";

const HELP = `CPU path trace example (build the engine first)
node examples/offline-path-trace.mjs --packet scene.json --camera camera.json --output image.hdr
  --width 64 --height 32 --spp 1024 --seed 17 --batch 8
  --min-samples 64 --noise-threshold 0.05 --environment 1,1,1
  --preview  Write image.preview.hdr and a preview receipt; final export still requires convergence.
Ctrl+C cancels between samples. Existing outputs are never overwritten.
`;

function argumentsOf(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    packet: { type: "string" }, camera: { type: "string" }, output: { type: "string" },
    width: { type: "string", default: "64" }, height: { type: "string", default: "32" },
    spp: { type: "string", default: "1024" }, seed: { type: "string", default: "17" },
    batch: { type: "string", default: "8" }, "min-samples": { type: "string" },
    "noise-threshold": { type: "string", default: "0.05" }, environment: { type: "string", default: "1,1,1" },
    preview: { type: "boolean", default: false }, help: { type: "boolean", short: "h", default: false },
  } });
  if (values.help) return { help: true };
  for (const key of ["packet", "camera", "output"]) if (!values[key]) throw new Error(`--${key} is required.`);
  const integer = (key, min, max) => {
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`Invalid --${key}.`);
    return value;
  };
  const width = integer("width", 1, 16384), height = integer("height", 1, 16384);
  if (width * height > 4 * 1024 * 1024) throw new RangeError("Example resolution exceeds 4 million pixels.");
  const spp = integer("spp", 1, 1_000_000), batch = integer("batch", 1, 256), seed = integer("seed", 0, 0xffffffff);
  const minSamples = values["min-samples"] === undefined ? Math.min(64, spp) : integer("min-samples", 1, spp);
  const noiseThreshold = Number(values["noise-threshold"]);
  if (!Number.isFinite(noiseThreshold) || noiseThreshold <= 0 || noiseThreshold > 1) throw new RangeError("Invalid --noise-threshold.");
  const environmentParts = values.environment.split(",");
  if (environmentParts.some(value => value.trim() === "")) throw new RangeError("Invalid --environment RGB.");
  const environment = environmentParts.map(Number);
  if (environment.length !== 3 || environment.some(v => !Number.isFinite(v) || v < 0)) throw new RangeError("Invalid --environment RGB.");
  const output = resolve(values.output);
  if (extname(output).toLowerCase() !== ".hdr") throw new Error("--output must end in .hdr.");
  return { packet: resolve(values.packet), camera: resolve(values.camera), output, width, height, spp,
    batch, seed, minSamples, noiseThreshold, environment, preview: values.preview };
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
async function rejectExisting(path) {
  try { await access(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error(`Output already exists: ${path}`);
}
async function writeExclusive(path, bytes) {
  const handle = await open(path, "wx");
  try { await handle.writeFile(bytes); }
  catch (error) { await handle.close(); await unlink(path); throw error; }
  finally { await handle.close(); }
}

/** Thin consumer over the built SDK. Scheduler/AbortSignal belong to this Node host. */
export async function renderOfflineFile(argv, { signal, onProgress = () => {} } = {}) {
  const options = argumentsOf(argv);
  if (options.help) return { status: "help", text: HELP, exitCode: 0 };
  if (signal?.aborted) return { status: "cancelled", sampleCount: 0, residentBytes: 0, exitCode: 130 };
  const sdk = await import("@bim-studio/deep-engine");
  if (typeof sdk.createPathTraceRenderPacketKernel !== "function") throw new Error("Engine build lacks CPU path tracing; run the engine build first.");
  // Existing repository serializer module, not a public SDK subpath API.
  const { materializeRuntimeRenderPacket } = await import("../dist/runtimePackage/renderPacket.js");
  const [packetBytes, cameraBytes] = await Promise.all([readFile(options.packet), readFile(options.camera)]);
  const packet = materializeRuntimeRenderPacket(JSON.parse(packetBytes.toString("utf8")), "$.renderPacket");
  const camera = JSON.parse(cameraBytes.toString("utf8"));
  const kernel = sdk.createPathTraceRenderPacketKernel({ packet, camera,
    width: options.width, height: options.height, environment: options.environment,
    maxBounces: 8, rouletteStart: 3, rayEpsilon: 1e-5 });
  const output = options.preview ? options.output.slice(0, -4) + ".preview.hdr" : options.output;
  const receiptPath = output + ".receipt.json";
  await rejectExisting(output); await rejectExisting(receiptPath);
  const render = new sdk.PathTraceCpuRender({ width: options.width, height: options.height,
    maxSamples: options.spp, minSamples: options.minSamples, varianceThreshold: options.noiseThreshold,
    maxAccumulationBytes: options.width * options.height * 24, sampleSeed: options.seed });
  const inputHashes = { renderPacket: sha256(packetBytes), camera: sha256(cameraBytes) };
  let hdrWritten = false, receiptWritten = false;
  const cancelled = async () => {
    if (receiptWritten) { await unlink(receiptPath); receiptWritten = false; }
    if (hdrWritten) { await unlink(output); hdrWritten = false; }
    render.cancel();
    return { status: "cancelled", sampleCount: render.session.sampleCount, residentBytes: render.session.residentBytes,
      output: null, exitCode: 130 };
  };
  try {
    const begin = render.begin({ sceneRevision: 1, materialHash: inputHashes.renderPacket, cameraHash: inputHashes.camera }, kernel, signal);
    if (begin.status !== "started") return { status: begin.status, exitCode: begin.status === "cancelled" ? 130 : 1 };
    while (render.session.sampleCount < options.spp) {
      const samples = Math.min(options.batch, options.spp - render.session.sampleCount);
      const outcome = await render.advanceAsync(samples, yieldToNode, signal);
      if (outcome.status === "cancelled") return { status: "cancelled", sampleCount: render.session.sampleCount,
        residentBytes: render.session.residentBytes, exitCode: 130 };
      if (outcome.status !== "advanced") throw new Error(`Path trace batch rejected: ${outcome.status}`);
      onProgress({ sampleCount: render.session.sampleCount, maxSamples: options.spp, converged: render.converged });
      await yieldToNode();
      if (signal?.aborted) { render.cancel(); return { status: "cancelled", sampleCount: render.session.sampleCount,
        residentBytes: render.session.residentBytes, exitCode: 130 }; }
    }
    const converged = render.converged, rse = render.maxRelativeStandardError;
    if (!converged && !options.preview) return { status: "rejected-noise", sampleCount: render.session.sampleCount,
      maxRelativeStandardError: Number.isFinite(rse) ? rse : null, threshold: options.noiseThreshold,
      output: null, exitCode: 2 };
    const image = render.image();
    const bytes = options.preview ? sdk.encodeRadianceHdr(image) : render.exportHdr().bytes;
    const decoded = sdk.decodeRadianceHdr(bytes);
    let roundtripMaxAbsoluteError = 0, maximumLinearValue = 0;
    for (let i = 0; i < image.data.length; i++) {
      maximumLinearValue = Math.max(maximumLinearValue, image.data[i]);
      roundtripMaxAbsoluteError = Math.max(roundtripMaxAbsoluteError, Math.abs(image.data[i] - decoded.data[i]));
    }
    const receipt = { status: options.preview ? "preview" : "final", converged, profile: kernel.profile,
      width: options.width, height: options.height, seed: options.seed, sampleCount: render.session.sampleCount,
      environment: options.environment, minSamples: options.minSamples,
      transport: { maxBounces: 8, rouletteStart: 3, rayEpsilon: 1e-5 },
      instanceCount: kernel.instanceCount, uniqueBlasCount: kernel.uniqueBlasCount,
      maxRelativeStandardError: Number.isFinite(rse) ? rse : null, noiseThreshold: options.noiseThreshold,
      format: "radiance-hdr-rgbe", inputHashes, hdrSha256: sha256(bytes), maximumLinearValue,
      roundtripMaxAbsoluteError, output, receiptPath };
    if (signal?.aborted) return await cancelled();
    await mkdir(dirname(output), { recursive: true });
    if (signal?.aborted) return await cancelled();
    await writeExclusive(output, bytes); hdrWritten = true;
    if (signal?.aborted) return await cancelled();
    await writeExclusive(receiptPath, JSON.stringify(receipt, null, 2) + "\n"); receiptWritten = true;
    if (signal?.aborted) return await cancelled();
    return { ...receipt, exitCode: options.preview ? 2 : 0 };
  } catch (error) {
    if (receiptWritten) await unlink(receiptPath);
    if (hdrWritten) await unlink(output);
    throw error;
  } finally { render.dispose(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  try {
    const result = await renderOfflineFile(process.argv.slice(2), { signal: controller.signal,
      onProgress: event => process.stderr.write(JSON.stringify({ phase: "progress", ...event }) + "\n") });
    process.stdout.write(result.status === "help" ? result.text : JSON.stringify(result) + "\n");
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(error.message + "\n"); process.exitCode = 1;
  } finally { process.off("SIGINT", cancel); }
}
