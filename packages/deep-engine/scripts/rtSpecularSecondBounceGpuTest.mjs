import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const output = path.resolve(process.env.RT_SECOND_BOUNCE_OUTPUT ?? path.join(repoRoot, "test-output/rt-second-bounce-20261007"));
const bytes = value => Uint8Array.from(Buffer.from(value, "base64"));
const f32 = value => new Float32Array(bytes(value).buffer);
const hash = value => createHash("sha256").update(value).digest("hex");
const percentile = (samples, q) => [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * q) - 1)] ?? null;

async function main() {
  const directory = await mkdtemp(path.join(tmpdir(), "rt-second-bounce-"));
  const bundle = path.join(directory, "probe.mjs");
  let browser;
  let server;
  try {
    await build({ absWorkingDir: packageRoot, entryPoints: ["lab/rtSpecularSecondBounceGpuProbe.ts"], bundle: true,
      format: "esm", target: "es2022", outfile: bundle, logLevel: "silent" });
    const module = await import(pathToFileURL(bundle));
    server = createServer(async (request, response) => {
      if (request.url === "/probe.mjs") response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(bundle));
      else response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>RT second bounce</title>");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const require = createRequire(import.meta.url);
    const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
    browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
      ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: process.env.RT_SECOND_BOUNCE_HEADED !== "1",
      args: ["--enable-unsafe-webgpu"] });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const runs = [];
    for (const secondBounce of [false, true]) {
      runs.push(await page.evaluate(async enabled => (await import("./probe.mjs")).runRtSpecularGiGpuProbe({ secondBounce: enabled }), secondBounce));
    }
    const [one, two] = runs;
    if (runs.some(run => run.errors.length || !run.hitRecordsBase64)) throw new Error(JSON.stringify(runs.map(run => run.errors)));
    const resolution = module.REFLECTION_RESOLUTION;
    const pixels = resolution ** 2;
    const decode = value => module.unpackRgba16Float(bytes(value).buffer, pixels);
    const hits = f32(two.hitRecordsBase64), hits2 = f32(two.hit2Base64), shading = f32(two.bounceShadingBase64), shading2 = f32(two.shading2Base64);
    const depth = f32(two.linearDepthBase64), normals = bytes(two.viewNormalBase64);
    const ssr = decode(two.ssrOutputBase64), trace = decode(two.traceBase64), indirect = decode(two.indirectionBase64);
    const fill = decode(two.fillOnBase64), off = decode(two.fillOffBase64), baseline = decode(one.indirectionBase64);
    const geometry = module.referenceSecondBounce(f32(two.sourceDepthBase64));
    const cpu = module.buildRtSpecularCpuReference(hits, depth, normals, ssr, trace, shading, hits2, shading2);
    let identity = 0, travel = 0, normal = 0, material = 0, visibility = 0, uninitialized = 0;
    let secondHits = 0, changed = 0, missEnergy = 0, ssrMismatch = 0, offMismatch = 0;
    let fractionDelta = 0, radianceRelative = 0, fillRelative = 0;
    let firstGeometryMismatch, maximumTravelRelative = 0, maximumTravelAbsolute = 0;
    for (let p = 0; p < pixels; p++) {
      const b = p * 4, gt = hits2[b], ct = geometry.records[b];
      if (gt === 0) uninitialized++;
      if ((gt > 0) !== (ct > 0)) { identity++; firstGeometryMismatch ??= { pixel: p, gpu: gt, cpu: ct }; }
      if (gt > 0 && ct > 0) {
        secondHits++;
        maximumTravelRelative = Math.max(maximumTravelRelative, Math.abs(gt - ct) / Math.abs(ct));
        maximumTravelAbsolute = Math.max(maximumTravelAbsolute, Math.abs(gt - ct));
        if (Math.abs(gt - ct) > Math.max(0.002 * Math.abs(ct), 0.0001)) {
          travel++; firstGeometryMismatch ??= { pixel: p, gpu: gt, cpu: ct, relative: Math.abs(gt - ct) / Math.abs(ct) };
        }
        if (hits2[b + 1] * geometry.records[b + 1] + hits2[b + 2] * geometry.records[b + 2]
          + hits2[b + 3] * geometry.records[b + 3] < 0.999) normal++;
        if ([0, 1, 2].some(c => Math.abs(shading2[b + c] - geometry.shading[b + c]) > 1e-5)) material++;
        if (shading2[b + 3] !== geometry.shading[b + 3]) visibility++;
        if (trace[b + 3] === 0 && [0, 1, 2].some(c => indirect[b + c] - baseline[b + c] > 1e-5)) changed++;
      }
      if (gt <= 0 && [0, 1, 2, 3].some(c => shading2[b + c] !== 0)) missEnergy++;
      fractionDelta = Math.max(fractionDelta, Math.abs(indirect[b + 3] - cpu.indirection[b + 3]));
      for (let c = 0; c < 4; c++) {
        if (off[b + c] !== ssr[b + c]) offMismatch++;
        if (trace[b + 3] > 0 && fill[b + c] !== ssr[b + c]) ssrMismatch++;
        if (c < 3) {
          radianceRelative = Math.max(radianceRelative, Math.abs(indirect[b + c] - cpu.indirection[b + c]) / (Math.abs(cpu.indirection[b + c]) + 0.05));
          fillRelative = Math.max(fillRelative, Math.abs(fill[b + c] - cpu.fill[b + c]) / (Math.abs(cpu.fill[b + c]) + 0.1));
        }
      }
    }
    const gates = {
      firstBounceUnchanged: { pass: one.hitRecordsBase64 === two.hitRecordsBase64 && one.bounceShadingBase64 === two.bounceShadingBase64 },
      independentSecondHitGeometry: { pass: identity + travel + normal + uninitialized === 0 && secondHits >= 40,
        secondHits, identity, travel, normal, uninitialized, firstGeometryMismatch,
        maximumTravelRelative, maximumTravelAbsolute, tolerance: { travelRelative: 0.002, travelAbsolute: 0.0001, normalDot: 0.999 } },
      independentMaterialVisibility: { pass: material + visibility + missEnergy === 0, material, visibility, missEnergy },
      cpuIndirectionAndFill: { pass: fractionDelta <= 0.02 && radianceRelative <= 0.035 && fillRelative <= 0.035,
        fractionDelta, radianceRelative, fillRelative, tolerance: { fraction: 0.02, radianceRelative: 0.035 } },
      secondBounceVisible: { pass: changed >= 40, changed, minimum: 40 },
      ssrPriorityAndToggleOff: { pass: ssrMismatch + offMismatch === 0, ssrMismatch, offMismatch },
      stackAndGpuErrors: { pass: runs.every(run => run.stackOverflows === 0 && run.errors.length === 0) },
    };
    const sources = ["lab/rtSpecularGiGpuProbe.ts", "lab/reflectionRayGpuCases.ts", "lab/rtSpecularSecondBounceReference.ts",
      "src/rayTracing/rayTraceClosestFrameKernel.ts", "src/rayTracing/rayTraceClosestFramePass.ts",
      "src/rayTracing/rtSpecularIndirectionKernel.ts", "src/rayTracing/rtSpecularFramePasses.ts", "src/rayTracing/rtSpecularIndirectionCpu.ts"];
    const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await readFile(path.join(packageRoot, name)))])));
    const performance = runs.map((run, i) => ({ bounceCount: i + 1, resolution, warmups: 3, iterations: 20,
      wallFullChain: { scope: "encode+submit+onSubmittedWorkDone, excludes readback", samplesMs: run.wallSamplesMs.fullChain,
        p50Ms: percentile(run.wallSamplesMs.fullChain, 0.5), p95Ms: percentile(run.wallSamplesMs.fullChain, 0.95) },
      gpuFullChain: { scope: "GPU timestamp bracket: closest+indirection+fill; excludes depth/DFG/preparation",
        samplesMs: run.gpuFullChainSamplesMs, p50Ms: percentile(run.gpuFullChainSamplesMs, 0.5), p95Ms: percentile(run.gpuFullChainSamplesMs, 0.95),
        available: run.gpuFullChainSamplesMs.length > 0 } }));
    const evidence = { schema: "rt-second-bounce-gpu-v1", createdAt: new Date().toISOString(), sourceHashes,
      environment: { chromeVersion: browser.version(), adapter: two.adapter, features: two.features,
        headed: process.env.RT_SECOND_BOUNCE_HEADED === "1" }, gates, performance,
      boundaries: ["Fixed 128² reflection harness; not editor or arbitrary scene frame budget.",
        "SSR input and view normals are synthetic uploads; closest-hit and both shading records are actual GPU outputs.",
        "Single conservative extra hop with per-instance albedo; no texture or full path-tracing estimator."],
      pass: Object.values(gates).every(gate => gate.pass) };
    await mkdir(output, { recursive: true });
    for (const [name, value] of Object.entries({ "hit2.bin": two.hit2Base64, "shading2.bin": two.shading2Base64,
      "indirection2.bin": two.indirectionBase64, "fill2.bin": two.fillOnBase64 })) await writeFile(path.join(output, name), bytes(value));
    await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ gates, performance: performance.map(({ wallFullChain, gpuFullChain, ...rest }) => ({ ...rest,
      wallP50Ms: wallFullChain.p50Ms, wallP95Ms: wallFullChain.p95Ms, gpuP50Ms: gpuFullChain.p50Ms, gpuP95Ms: gpuFullChain.p95Ms })),
      pass: evidence.pass, output }, null, 2));
    if (!evidence.pass) process.exitCode = 1;
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
await main();
