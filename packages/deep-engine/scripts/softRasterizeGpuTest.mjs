import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// 软光栅化 kernel 真机对拍 runner（追平-Nanite 三件套之三的 GPU 腿；模式沿用 clusterLodGpuTest.mjs）。
// headless Chrome + WebGPU：固定三角形集合（全屏大三角 / z-fighting 顺序互换 / 背面退化 /
// 越界部分覆盖 / 微三角亚像素+共享边+多 workgroup / NaN 与 slot 溢出故障通道 / 可见性目标级
// fallback-target-alias）在浏览器 bundle 内驱动 soft_rasterize 两阶段 kernel，读回
// slot/packedTriangle/depth + 故障哨兵；与 CPU 参考（webgpu/softRasterizeReference 经
// webgpu/softRasterizeFallback CPU 桥，同一 esbuild bundle 单一来源，防口径分叉）逐像素对拍：
// 命中集必须一致（slot/packedTriangle u32 精确相等），depth 相对容差 1e-5（f32 量化级）。
// r2：接线切片——打包改走 softRasterizeFallback.packSoftRasterTriangles 单一来源，新增
// 「可见性目标级」案例（目标初值含硬件已写内容 slot=7/packed=5，后备覆盖像素改写、
// 未覆盖像素保持，验证三缓冲 alias 语义）。
// 证据写入 test-output/soft-raster-gpu-20260921-r2/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "soft-raster-gpu-20260921-r2");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.SOFT_RASTER_GPU_TEST_ATTEMPTS ?? 3);
const DEPTH_RELATIVE_TOLERANCE = 1e-5;
const SENTINEL = 0xffff_ffff;

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

async function runInBrowser(origin, requests) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const result = await page.evaluate(async (caseRequests) => {
      const module = await import("./probe.bundle.mjs");
      return module.runSoftRasterGpuProbe(caseRequests);
    }, requests);
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

function compareCase(spec, readback, reference) {
  const width = spec.viewportWidth, height = spec.viewportHeight, pixels = width * height;
  const empty = { hitSetMismatches: 0, slotMismatches: 0, packedMismatches: 0, depthMismatches: 0,
    maxDepthRelError: 0, coveredCount: -1, shapeOk: false, mismatchSamples: [], pixelAgreement: false,
    gpuSlot: new Uint32Array(0), cpuSlot: reference.slot };
  if (!readback) return empty;
  const gpuSlot = new Uint32Array(base64ToBytes(readback.slotBase64).buffer);
  const gpuPacked = new Uint32Array(base64ToBytes(readback.packedTriangleBase64).buffer);
  const gpuDepth = new Float32Array(base64ToBytes(readback.depthBase64).buffer);
  if (gpuSlot.length !== pixels || gpuPacked.length !== pixels || gpuDepth.length !== pixels) return empty;
  const result = { ...empty, shapeOk: true, gpuSlot };
  const samples = [];
  for (let pixel = 0; pixel < pixels; pixel++) {
    const gpuHit = gpuSlot[pixel] !== SENTINEL, cpuHit = reference.slot[pixel] !== SENTINEL;
    let kind = null, relError = 0;
    if (gpuHit !== cpuHit) kind = "hit-set";
    else if (gpuHit) {
      if (gpuSlot[pixel] !== reference.slot[pixel]) kind = "slot";
      else if (gpuPacked[pixel] !== reference.packedTriangle[pixel]) kind = "packed";
      else {
        relError = Math.abs(gpuDepth[pixel] - reference.depth[pixel])
          / Math.max(Math.abs(reference.depth[pixel]), 1e-30);
        result.maxDepthRelError = Math.max(result.maxDepthRelError, relError);
        if (relError > DEPTH_RELATIVE_TOLERANCE) kind = "depth";
      }
    }
    if (kind === null) continue;
    result[`${kind === "packed" ? "packed" : kind === "depth" ? "depth" : "hitSet"}Mismatches`] += 1;
    if (samples.length < 8) samples.push({ pixel, x: pixel % width, y: Math.floor(pixel / width), kind,
      gpu: { slot: gpuSlot[pixel], packed: gpuPacked[pixel], depth: gpuDepth[pixel] },
      reference: { slot: reference.slot[pixel], packed: reference.packedTriangle[pixel],
        depth: reference.depth[pixel] }, relError });
  }
  result.mismatchSamples = samples;
  result.pixelAgreement = samples.length === 0;
  result.coveredCount = [...gpuSlot].filter(word => word !== SENTINEL).length;
  return result;
}

function zfightWinnerMap(spec, slots) {
  const { nearIndex, farIndex } = spec.zfightWinner;
  const nearSlot = spec.slotBase + nearIndex, farSlot = spec.slotBase + farIndex;
  return [...slots].map(word => word === nearSlot ? 1 : word === farSlot ? 2 : word === SENTINEL ? 0 : -1);
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "soft-raster-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/softRasterizeGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  const module = await import(pathToFileURL(bundlePath));
  await writeFile(path.join(bundleDirectory, "probe.html"), `<!doctype html><title>Soft rasterize GPU probe</title>`);

  const specs = module.buildSoftRasterCases();
  const requests = module.buildSoftRasterRequests(specs);
  // 逐像素基准：CPU 参考（同一 bundle 单一来源）；cpuSkipped 案例退化为「全保持初值」平凡合同。
  const references = new Map(specs.map((spec) => {
    const target = module.runSoftRasterCpuReference(spec);
    if (target) return [spec.name, { basis: "cpu-reference", slot: target.slot,
      packedTriangle: target.packedTriangle, depth: target.depth }];
    const pixels = spec.viewportWidth * spec.viewportHeight;
    return [spec.name, { basis: "trivial-initial-state", slot: new Uint32Array(pixels).fill(SENTINEL),
      packedTriangle: new Uint32Array(pixels), depth: new Float32Array(pixels).fill(1) }];
  }));

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin, requests);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { errors: [String(error instanceof Error ? error.message : error)], cases: {},
        adapter: {}, features: [], validationMessages: [], compilationMessages: [] };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  await mkdir(path.join(outputDirectory, "outputs"), { recursive: true });
  await writeFile(path.join(outputDirectory, "softRasterize.wgsl"), module.emitSoftRasterizeWgsl());

  const caseResults = [];
  const zfightMaps = new Map();
  let gate = Boolean(probe.cases) && Object.keys(probe.cases).length === specs.length && probe.errors.length === 0;
  for (const spec of specs) {
    const readback = probe.cases?.[spec.name];
    const reference = references.get(spec.name);
    const comparison = compareCase(spec, readback, reference);
    const faultsOk = readback !== undefined && readback.faults === spec.expectedFaults;
    const coveredOk = comparison.coveredCount >= spec.minCovered;
    let pixelOk = readback !== undefined && comparison.shapeOk && comparison.pixelAgreement;
    let zfightOk = null;
    if (spec.zfightWinner && readback !== undefined && comparison.shapeOk) {
      const gpuMap = zfightWinnerMap(spec, comparison.gpuSlot);
      const cpuMap = zfightWinnerMap(spec, reference.slot);
      zfightOk = gpuMap.every((value, index) => value === cpuMap[index]);
      zfightMaps.set(spec.name, { gpuMap, cpuMap });
      pixelOk &&= zfightOk;
    }
    gate &&= pixelOk && faultsOk && coveredOk && probe.validationMessages.length === 0;
    caseResults.push({ name: spec.name, note: spec.note, viewport: [spec.viewportWidth, spec.viewportHeight],
      triangleCount: spec.triangles.length, slotBase: spec.slotBase,
      dispatchWorkgroups: Math.ceil(spec.triangles.length / module.SOFT_RASTERIZE_WORKGROUP_SIZE),
      referenceBasis: reference.basis, cpuSkippedReason: spec.cpuSkippedReason ?? null,
      webgpuRan: readback !== undefined, faults: readback?.faults ?? null, expectedFaults: spec.expectedFaults,
      faultsOk, coveredCount: comparison.coveredCount, minCovered: spec.minCovered, coveredOk,
      hitSetMismatches: comparison.hitSetMismatches, slotMismatches: comparison.slotMismatches,
      packedMismatches: comparison.packedMismatches, depthMismatches: comparison.depthMismatches,
      pixelAgreement: pixelOk, zfightOrderInvariance: zfightOk,
      maxDepthRelError: comparison.maxDepthRelError.toExponential(3),
      depthRelativeTolerance: DEPTH_RELATIVE_TOLERANCE, mismatchSamples: comparison.mismatchSamples,
      gpuSlotSha256: readback ? sha256(base64ToBytes(readback.slotBase64)) : null,
      cpuSlotSha256: sha256(new Uint8Array(reference.slot.buffer)) });
  }

  const zfightEntries = [...zfightMaps.values()];
  const zfightAgreement = zfightEntries.length === 0 || zfightEntries.every((entry, _, all) =>
    entry.gpuMap.every((value, index) => value === all[0].gpuMap[index]));
  gate &&= zfightAgreement;

  const webgpuAvailable = Object.keys(probe.cases ?? {}).length > 0;
  const evidence = {
    schema: "soft-raster-gpu-evidence-v1",
    lane: "wave3-soft-rasterize-micro-triangle-real-gpu", createdAt: new Date().toISOString(),
    kernel: { name: "soft_rasterize_triangles (two-phase: depth_min -> write)",
      entryPoints: [module.SOFT_RASTERIZE_DEPTH_MIN_ENTRY_POINT, module.SOFT_RASTERIZE_WRITE_ENTRY_POINT],
      workgroupSizeX: module.SOFT_RASTERIZE_WORKGROUP_SIZE,
      bindingOrder: module.SOFT_RASTERIZE_BINDINGS.map(binding => `${binding.name}:${binding.type}`) },
    artifacts: { wgsl: { sha256: sha256(await readFile(path.join(outputDirectory, "softRasterize.wgsl"))),
      consumers: ["webgpu-dawn-headless", "native-wgpu-pending"] } },
    environment: { chromeVersion: probe.browserVersion ?? null, userAgent: probe.userAgent ?? null,
      adapter: probe.adapter ?? null, features: probe.features ?? [],
      kernelValidationMessages: probe.validationMessages ?? [], compilationMessages: probe.compilationMessages ?? [],
      probeErrors: probe.errors },
    cases: caseResults,
    verdict: {
      webgpuAvailable, cpuGpuAgreement: gate, zfightOrderAgreement: zfightAgreement,
      notes: [
        "CPU 参考与浏览器腿共用同一 esbuild bundle（案例几何 / 10×f32 打包 / CPU 光栅化单一来源，防口径分叉）。",
        "对拍合同：逐像素命中集一致（slot/packedTriangle u32 精确相等）；depth 相对容差 1e-5（f32 量化级），实测最大相对误差随证据记录。",
        "数值纪律：全部顶点坐标 dyadic（k/4）——edge 函数的差与积在 f32/f64 下精确表示，命中集判定无舍入歧义；重叠三角深度分离 ≥1.56e-3，比 f32 插值噪声高约 4 个量级，胜者判定对舍入稳健。",
        "断言族：全屏大三角斜坡深度插值 / z-fighting 顺序互换胜者图逐像素一致（depth-less 语义顺序无关）/ 背面+共线+重复点零写入 / 越界 bbox 负向钳制（WGSL u32(f32) 截断路径真机受检）/ 亚像素微三角+对角共享边双覆盖 / NaN 坐标与 slot 溢出故障哨兵。",
        "triangleCount=68（micro-subpixel-grid）> 64：第二个 workgroup 与 60 个越界尾 lane 同机受检越界守卫。",
        "storage 能力结论：本 kernel 读写全部为 storage buffer（array<u32>/array<f32>），非 storage texture——rg32uint 只是硬件 visibility pass 的附件格式命名（VISIBILITY_ATTACHMENT_FORMAT），不在本 kernel 路径；真机 pipeline/binding 未要求任何可选 feature（adapter.features 全表随证据记录）。",
        "kernel 小修（本切片）：params 从 var<storage,read> 改为 var<uniform>，对齐 SOFT_RASTERIZE_BINDINGS 合同（type:\"uniform\"）与 clusterLodSelectionKernel 同族模式；16B 布局不变。另将 @workgroup_size 抽为导出常量单一来源。",
        "r2 接线切片：三角打包与 CPU 基准改走 webgpu/softRasterizeFallback 的 packSoftRasterTriangles / rasterizePackedTrianglesCpu（与渲染器 VisibilityBufferPath 后备段同一函数，单一来源）；fallback-target-alias 案例验证「写入现有可见性目标」的三缓冲 alias 语义（覆盖像素改写 slot/packed、未覆盖像素保持硬件初值 slot=7/packed=5/depth=1.0）。",
        "faults 哨兵非零即整案例拒绝（NaN/slot 溢出案例的哨兵值本身是受检对象：expectedFaults 精确相等）。",
      ],
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  const summary = caseResults.map((entry) => `${entry.name}: covered=${entry.coveredCount}/${entry.viewport[0] * entry.viewport[1]} ` +
    `faults=${entry.faults} hit/slot/packed/depth=${entry.hitSetMismatches}/${entry.slotMismatches}/` +
    `${entry.packedMismatches}/${entry.depthMismatches} maxRelErr=${entry.maxDepthRelError} ` +
    `px=${entry.pixelAgreement ? "match" : "MISMATCH"} zfight=${entry.zfightOrderInvariance ?? "n/a"}`).join("\n");
  console.log(summary);
  console.log(`WebGPU available: ${webgpuAvailable}; CPU/GPU agreement verdict: ${gate ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!gate) process.exitCode = 1;
}

await main();
