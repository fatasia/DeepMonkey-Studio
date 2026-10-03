import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// 阴影光线 GPU 探针 runner（compute BVH 光追骨架验收门；harness 沿用 rayTraceGpuTest.mjs）。
// headless Chrome + WebGPU 完整 API 路径（ShadowRayMaskPass 持久缓冲 → dispatch → 读回），
// Node 侧同一 bundle 出 CPU 参考掩码（traceTlasClosest 仲裁）与软件光栅 shadow map（RMSE 门）。
// 门：① 10k rays GPU dispatch < 2ms（timestamp-query 实测，不可用时记 wall 并如实标注）
//    ② GPU mask == CPU mask（逐射线相等）  ③ mask vs 光栅 shadow map RMSE ≤ 0.05
//    ④ f16 档 mask == f32 档 mask（shader-f16 可用时）。证据写 test-output/shadow-ray-gpu-20261003/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "shadow-ray-gpu-20261003");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.SHADOW_RAY_GPU_TEST_ATTEMPTS ?? 3);
const GPU_MS_BUDGET = 2, RMSE_BUDGET = 0.05;

const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const base64ToBytes = (value) => Uint8Array.from(Buffer.from(value, "base64"));

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method !== "GET" || !["probe.html", "probe.bundle.mjs"].includes(name)) {
      response.writeHead(404).end(); return;
    }
    response.writeHead(200, { "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" })
      .end(await readFile(path.join(directory, name)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runInBrowser(origin) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const result = await page.evaluate(async () => {
      const module = await import("./probe.bundle.mjs");
      return module.runShadowRayGpuProbe();
    });
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "shadow-ray-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/shadowRayGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  const module = await import(pathToFileURL(bundlePath));
  await writeFile(path.join(bundleDirectory, "probe.html"), `<!doctype html><title>Shadow ray GPU probe</title>`);

  const casesSpec = module.buildShadowCases();
  const receivers = module.buildReceiverPoints(casesSpec.receiverGrid);
  const reference = module.cpuShadowMask(casesSpec.scene, receivers);
  const rasterMap = module.rasterizeShadowMap(casesSpec.scene);
  const rasterMask = new Uint32Array(receivers.length / 3);
  for (let i = 0; i < rasterMask.length; i++) {
    rasterMask[i] = module.sampleRasterShadow(rasterMap, [receivers[i * 3], receivers[i * 3 + 1], receivers[i * 3 + 2]]);
  }
  const cpuOccluded = reference.mask.filter(v => v === 0).length;
  const rasterOccluded = rasterMask.filter(v => v === 0).length;
  console.log(`CPU reference: ${reference.mask.length} rays, occluded=${cpuOccluded}; raster shadow map: occluded=${rasterOccluded}`);

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0 && Object.keys(probe.cases).length > 0) break;
    } catch (error) {
      probe = { errors: [String(error instanceof Error ? error.message : error)], cases: {} };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  await mkdir(path.join(outputDirectory, "outputs"), { recursive: true });
  const wgsl = module.emitShadowRayMaskKernelWgsl();
  await writeFile(path.join(outputDirectory, "shadowRayMask.wgsl"), wgsl);

  const caseResults = [];
  let gate = probe.errors.length === 0 && Object.keys(probe.cases).length > 0;
  const f32Result = probe.cases?.f32 ?? null;
  for (const [name, backend] of Object.entries(probe.cases ?? {})) {
    const gpuMask = backend.maskBase64 !== undefined
      ? new Uint32Array(base64ToBytes(backend.maskBase64).buffer.slice(0)) : new Uint32Array(0);
    const maskEqualCpu = gpuMask.length === reference.mask.length &&
      gpuMask.every((v, i) => v === reference.mask[i]);
    const rmse = gpuMask.length === reference.mask.length ? module.shadowMaskRmse(gpuMask, rasterMask) : 1;
    const timingSource = backend.gpuMs !== null ? "timestamp-query" : "wall-incl-readback";
    const timingMs = backend.gpuMs ?? backend.wallMs;
    const perfGate = backend.rayCount === casesSpec.perfRays ? timingMs < GPU_MS_BUDGET : null;
    const f16Parity = name === "f16" && f32Result !== null
      ? gpuMask.every((v, i) => v === (new Uint32Array(base64ToBytes(f32Result.maskBase64).buffer.slice(0)))[i]) : null;
    gate &&= maskEqualCpu && backend.stackOverflows === 0 && (perfGate === null || perfGate) && rmse <= RMSE_BUDGET
      && (f16Parity === null || f16Parity);
    caseResults.push({
      variant: name, rayCount: backend.rayCount, occluded: gpuMask.filter(v => v === 0).length,
      gpuMs: backend.gpuMs, wallMs: Number(backend.wallMs.toFixed(3)), timingSource,
      perfGate, perfBudgetMs: GPU_MS_BUDGET, maskEqualsCpu: maskEqualCpu,
      maskSha256: sha256(base64ToBytes(backend.maskBase64)),
      rmseVsRasterShadowMap: Number(rmse.toFixed(5)), rmseBudget: RMSE_BUDGET, f16Parity,
      stackOverflows: backend.stackOverflows,
    });
    if (gpuMask.length > 0) {
      await writeFile(path.join(outputDirectory, "outputs", `${name}.mask.bin`), Buffer.from(gpuMask.buffer));
    }
  }

  const evidence = {
    schema: "shadow-ray-gpu-evidence-v1",
    lane: "compute-bvh-skeleton + directional-shadow-ray-pass", createdAt: new Date().toISOString(),
    kernel: { name: "shadow_ray_mask_batch", entryPoint: "shadow_ray_mask_batch",
      workgroupSizeX: 64, stackCapacity: 32, semantics: "occlusion query (hit=occluded/0, miss=visible/1)" },
    artifacts: {
      wgsl: { sha256: sha256(await readFile(path.join(outputDirectory, "shadowRayMask.wgsl"))),
        consumers: ["webgpu-dawn", "native-wgpu-pending"] },
      f32Mask: caseResults.find(c => c.variant === "f32")?.maskSha256 ?? null,
    },
    environment: {
      chromeVersion: probe.browserVersion ?? null, userAgent: probe.userAgent ?? null,
      adapter: probe.adapter ?? null, features: probe.features, probeErrors: probe.errors,
      shaderF16: probe.shaderF16, timestampQuery: probe.timestampQuery,
    },
    reference: { rayCount: reference.mask.length, occluded: cpuOccluded,
      rasterShadowMapOccluded: rasterOccluded, rasterResolution: module.SHADOW_RASTER_RESOLUTION },
    cases: caseResults,
    verdict: {
      gate,
      gates: {
        perf: caseResults.find(c => c.variant === "f32")?.perfGate ?? false,
        maskEqualsCpu: caseResults.find(c => c.variant === "f32")?.maskEqualsCpu ?? false,
        rmseVsRasterShadowMap: (caseResults.find(c => c.variant === "f32")?.rmseVsRasterShadowMap ?? 1) <= RMSE_BUDGET,
        f16Parity: caseResults.find(c => c.variant === "f16")?.f16Parity ?? "skipped (no shader-f16)",
      },
      notes: [
        "CPU 参考与浏览器腿共用同一 esbuild bundle（buildShadowScene/IncrementalTlas/SAH BLAS/执行器单一来源，防口径分叉）。",
        "门① GPU dispatch 时间优先 timestamp-query 实测；不可用时降级 wall（含读回整程）并如实标注来源。",
        "门③ 光栅 shadow map 为本探针内软件正交 z-buffer 参考（复用 RT 阴影语义），RMSE ≤ 0.05（同点集同分辨率）。",
        "门④ f16 档为 BvhNodeF16 32B 外扩量化布局；mask 必须与 f32 档逐位一致（剪枝只松不紧合同）。",
      ],
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  for (const result of caseResults) {
    console.log(`${result.variant}: rays=${result.rayCount} occluded=${result.occluded} ` +
      `${result.timingSource}=${result.gpuMs ?? result.wallMs}ms perf=${result.perfGate} ` +
      `mask==cpu=${result.maskEqualsCpu} rmse=${result.rmseVsRasterShadowMap} ` +
      `f16parity=${result.f16Parity ?? "n/a"}`);
  }
  console.log(`Verdict: ${gate ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!gate) process.exitCode = 1;
}

await main();
