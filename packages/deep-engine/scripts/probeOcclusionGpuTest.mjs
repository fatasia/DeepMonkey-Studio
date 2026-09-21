import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// Probe 遮挡射线扩展真机对拍 runner（RayBackend 第四消费者的 GPU 腿；模式沿用 rayTraceGpuTest.mjs /
// softRasterizeGpuTest.mjs）。headless Chrome + WebGPU：固定场景三案例（封闭壳/头顶平板/开阔/tiny 壳
// 四探针；每帧预算钳制；occluderMask 端到端过滤）在浏览器 bundle 内走完整 API 路径
// probeOcclusionEstimatesWithRayExtension（闸门序 → 批次构造 → RayTraceGpuTlasExecutor 两级真实
// dispatch → 读回 → 聚合）。与 CPU 参考（同一 esbuild bundle 单一来源，防口径分叉）三层对拍：
// 逐射线（compareTlasGpuAgainstCpu + 解析闭式 t，相对 1e-5）、聚合统计（missRatio/buried 精确，
// mean/nearest 相对 1e-5，variance 相对 1e-4——f32 量化级）、解析遮挡率（1 / 0.5 / 0 闭式锚点）。
// 证据写入 test-output/probe-occlusion-gpu-20260921-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "probe-occlusion-gpu-20260921-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.PROBE_OCCLUSION_GPU_TEST_ATTEMPTS ?? 3);
const T_RELATIVE_TOLERANCE = 1e-5;
const MEAN_RELATIVE_TOLERANCE = 1e-5;
const VARIANCE_RELATIVE_TOLERANCE = 1e-4;

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
      return module.runProbeOcclusionGpuProbe(caseRequests);
    }, requests);
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

const relativeDelta = (value, expected) =>
  Math.abs(value - expected) / Math.max(Math.abs(expected), 1e-30);

function pushMismatch(sink, message) {
  if (sink.length < 8) sink.push(message);
}

/** 逐射线仲裁第三腿：GPU 与 CPU 原始命中各自对解析闭式 t（命中/缺席 + 相对容差）。 */
function compareRawAgainstAnalytic(spec, prepared, gpuHits) {
  const mismatches = [];
  let mismatchCount = 0;
  let maxRelativeTDelta = 0;
  const directionCount = prepared.resolved.directionCount;
  const dispatched = Math.min(prepared.batch.dispatched.length, spec.analytic.length);
  for (let probeIndex = 0; probeIndex < dispatched; probeIndex++) {
    const expectation = spec.analytic[probeIndex];
    for (let ordinal = 0; ordinal < directionCount; ordinal++) {
      const ray = probeIndex * directionCount + ordinal;
      const expected = expectation.analyticHits[ordinal];
      for (const [leg, hit] of [["gpu", gpuHits[ray]], ["cpu", prepared.cpuRawHits[ray]]]) {
        const present = hit !== undefined;
        if (present !== (expected !== undefined)) {
          mismatchCount++;
          pushMismatch(mismatches, `probe ${probeIndex}(${expectation.label}) dir ${ordinal}: ${leg} hit presence=${present} analytic=${expected !== undefined}`);
          continue;
        }
        if (!present) continue;
        const relative = relativeDelta(hit.t, expected);
        maxRelativeTDelta = Math.max(maxRelativeTDelta, relative);
        if (!(relative <= T_RELATIVE_TOLERANCE)) {
          mismatchCount++;
          pushMismatch(mismatches, `probe ${probeIndex}(${expectation.label}) dir ${ordinal}: ${leg} t=${hit.t} analytic=${expected} relative=${relative}`);
        }
      }
    }
  }
  return { passed: mismatchCount === 0, mismatchCount, maxRelativeTDelta, firstMismatches: mismatches };
}

/** 聚合统计三层仲裁（GPU 估计 vs CPU 估计 vs 解析）+ 预算钳制尾部双侧无估计 + 双腿扩展统计一致。 */
function compareEstimates(spec, prepared, backend) {
  const perProbe = [];
  let passed = true;
  const gpuEstimates = backend?.estimates ?? [];
  const cpuEstimates = prepared.cpuChain.estimates;
  const fail = (message) => { passed = false; return message; };
  for (let index = 0; index < spec.probes.length; index++) {
    const gpu = gpuEstimates[index] ?? null;
    const cpu = cpuEstimates[index];
    const analytic = index < spec.analytic.length && index < prepared.batch.dispatched.length
      ? spec.analytic[index] : undefined;
    const entry = { index, label: analytic?.label ?? "clamped-past-budget" };
    if (analytic === undefined) {
      // 预算钳制截断尾部：合同要求双侧估计 undefined（fail-closed，无数据写入）。
      entry.clampedAway = true;
      entry.gpuUndefined = gpu === null;
      entry.cpuUndefined = cpu === undefined;
      if (gpu !== null || cpu !== undefined) entry.error = fail(`probe ${index}: clamped tail must stay estimate-free (gpu=${JSON.stringify(gpu)} cpu=${JSON.stringify(cpu) ?? "undefined"})`);
      perProbe.push(entry);
      continue;
    }
    if (gpu === null || cpu === undefined) {
      entry.error = fail(`probe ${index}: estimate presence broken (gpu=${gpu === null ? "null" : "present"} cpu=${cpu === undefined ? "undefined" : "present"})`);
      perProbe.push(entry);
      continue;
    }
    Object.assign(entry, {
      gpu: { missRatio: gpu.missRatio, meanDistance: gpu.meanDistance,
        distanceVariance: gpu.distanceVariance, nearestHitDistance: gpu.nearestHitDistance ?? null,
        buried: gpu.buried },
      cpu: { missRatio: cpu.missRatio, meanDistance: cpu.meanDistance,
        distanceVariance: cpu.distanceVariance, nearestHitDistance: cpu.nearestHitDistance ?? null,
        buried: cpu.buried },
      analytic: { missRatio: analytic.expectedMissRatio, meanDistance: analytic.expectedMeanDistance,
        distanceVariance: analytic.expectedDistanceVariance,
        nearestHitDistance: analytic.expectedNearestHitDistance ?? null, buried: analytic.expectedBuried },
    });
    if (gpu.index !== index || cpu.index !== index) entry.error = fail(`probe ${index}: estimate index misaligned (gpu=${gpu.index} cpu=${cpu.index})`);
    // missRatio/visibilityFloor：命中集一致（逐射线仲裁）⇒ 三方必须精确相等。
    entry.missRatioExact = gpu.missRatio === cpu.missRatio
      && gpu.missRatio === analytic.expectedMissRatio
      && gpu.visibilityFloor === gpu.missRatio;
    if (!entry.missRatioExact) entry.error = fail(`probe ${index}: missRatio gpu=${gpu.missRatio} cpu=${cpu.missRatio} analytic=${analytic.expectedMissRatio}`);
    // meanDistance：f32 量化级（相对 1e-5）。
    entry.meanRelDeltaGpu = relativeDelta(gpu.meanDistance, analytic.expectedMeanDistance);
    entry.meanRelDeltaCpu = relativeDelta(cpu.meanDistance, analytic.expectedMeanDistance);
    entry.meanRelDeltaCross = relativeDelta(gpu.meanDistance, cpu.meanDistance);
    if (!(entry.meanRelDeltaGpu <= MEAN_RELATIVE_TOLERANCE
      && entry.meanRelDeltaCpu <= MEAN_RELATIVE_TOLERANCE
      && entry.meanRelDeltaCross <= MEAN_RELATIVE_TOLERANCE)) {
      entry.error = fail(`probe ${index}: meanDistance gpu=${gpu.meanDistance} cpu=${cpu.meanDistance} analytic=${analytic.expectedMeanDistance}`);
    }
    // distanceVariance：相对 1e-4；解析 0（开放语义）时合同双侧恒等于 0。
    entry.varianceRelDeltaGpu = relativeDelta(gpu.distanceVariance, analytic.expectedDistanceVariance);
    entry.varianceRelDeltaCpu = relativeDelta(cpu.distanceVariance, analytic.expectedDistanceVariance);
    if (analytic.expectedDistanceVariance < 1e-12) {
      entry.varianceExactZero = gpu.distanceVariance === 0 && cpu.distanceVariance === 0
        && analytic.expectedDistanceVariance === 0;
      if (!entry.varianceExactZero) entry.error = fail(`probe ${index}: variance must be exactly 0 (gpu=${gpu.distanceVariance} cpu=${cpu.distanceVariance})`);
    } else if (!(entry.varianceRelDeltaGpu <= VARIANCE_RELATIVE_TOLERANCE
      && entry.varianceRelDeltaCpu <= VARIANCE_RELATIVE_TOLERANCE)) {
      entry.error = fail(`probe ${index}: variance gpu=${gpu.distanceVariance} cpu=${cpu.distanceVariance} analytic=${analytic.expectedDistanceVariance}`);
    }
    // nearest：存在性三方一致 + 相对 1e-5。
    const nearestAnalytic = analytic.expectedNearestHitDistance;
    if ((gpu.nearestHitDistance === undefined) !== (nearestAnalytic === undefined)
      || (cpu.nearestHitDistance === undefined) !== (nearestAnalytic === undefined)) {
      entry.error = fail(`probe ${index}: nearest presence gpu=${String(gpu.nearestHitDistance)} cpu=${String(cpu.nearestHitDistance)} analytic=${String(nearestAnalytic)}`);
    } else if (nearestAnalytic !== undefined) {
      entry.nearestRelDeltaGpu = relativeDelta(gpu.nearestHitDistance, nearestAnalytic);
      entry.nearestRelDeltaCpu = relativeDelta(cpu.nearestHitDistance, nearestAnalytic);
      if (!(entry.nearestRelDeltaGpu <= MEAN_RELATIVE_TOLERANCE
        && entry.nearestRelDeltaCpu <= MEAN_RELATIVE_TOLERANCE)) {
        entry.error = fail(`probe ${index}: nearest gpu=${gpu.nearestHitDistance} cpu=${cpu.nearestHitDistance} analytic=${nearestAnalytic}`);
      }
    }
    // buried：三方布尔精确一致。
    entry.buriedExact = gpu.buried === cpu.buried && gpu.buried === analytic.expectedBuried;
    if (!entry.buriedExact) entry.error = fail(`probe ${index}: buried gpu=${gpu.buried} cpu=${cpu.buried} analytic=${analytic.expectedBuried}`);
    entry.passed = entry.error === undefined;
    passed &&= entry.passed;
    perProbe.push(entry);
  }
  // 双腿扩展统计一致（派发探针/射线数、钳制旗标、方向数、mask）。
  const statsAgreement = backend !== undefined
    && backend.dispatchedProbes === prepared.cpuChain.extension.dispatchedProbes
    && backend.rayCount === prepared.cpuChain.extension.dispatchedRays
    && backend.clamped === prepared.cpuChain.extension.budgetClamped
    && backend.directionCount === prepared.cpuChain.extension.directionCount
    && backend.occluderMask === prepared.resolved.occluderMask;
  if (!statsAgreement) passed = fail("extension stats disagree between gpu backend and cpu chain.");
  return { passed, statsAgreement, perProbe };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "probe-occlusion-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/probeOcclusionGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  const module = await import(pathToFileURL(bundlePath));
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><title>Probe occlusion GPU probe</title>`);

  const specs = module.buildProbeOcclusionCases();
  const requests = specs.map((spec) => module.encodeProbeOcclusionCaseRequest(spec));
  // CPU 参考（Node 侧，同一 bundle 单一来源）：原始逐射线 + 全链扩展估计。
  const prepared = new Map(specs.map((spec) => {
    const tlas = module.buildTlas(spec.instances);
    const packed = module.packTlasScene(tlas);
    const resolved = module.resolveProbeOcclusionRayExtensionOptions(spec.options);
    const candidates = module.collectProbeOcclusionRayExtensionCandidates(spec.probes);
    const batch = module.buildProbeOcclusionRayExtensionBatch(candidates, resolved);
    const queries = module.batchQueryToTlasQueries(batch.query);
    const cpuRawHits = queries.map((ray) => module.traceTlasClosest(tlas, ray, batch.query.mask));
    return [spec.name, { tlas, packed, resolved, candidates, batch, queries, cpuRawHits,
      gpuShape: module.encodeGpuTlasHits(cpuRawHits) }];
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

  await mkdir(path.join(outputDirectory, "inputs"), { recursive: true });
  await mkdir(path.join(outputDirectory, "outputs"), { recursive: true });
  const wgsl = module.emitTwoLevelRayTraceKernelWgsl();
  await writeFile(path.join(outputDirectory, "rayTraceTlasBatch.wgsl"), wgsl);

  const caseResults = [];
  let gate = Boolean(probe.cases) && Object.keys(probe.cases).length === specs.length
    && probe.errors.length === 0 && probe.validationMessages.length === 0;
  for (const spec of specs) {
    const cpu = prepared.get(spec.name);
    const backend = probe.cases?.[spec.name];
    const gpuBuffer = backend ? base64ToBytes(backend.rawHitsBase64) : new Uint8Array(0);
    const gpuHits = backend && gpuBuffer.byteLength > 0
      ? module.decodeGpuTlasHits(gpuBuffer.buffer.slice(0)) : [];
    const rawComparison = gpuHits.length > 0
      ? module.compareTlasGpuAgainstCpu(cpu.tlas, cpu.queries, gpuHits, cpu.packed.placements,
        cpu.batch.query.mask)
      : { rayCount: cpu.queries.length, passed: false, mismatchCount: -1, maxRelativeTDelta: -1,
        firstMismatches: ["backend case missing"] };
    const rawAnalytic = compareRawAgainstAnalytic(spec, cpu, gpuHits);
    // CPU 全链扩展估计（同一 bundle；与 GPU 腿共用聚合单一来源）。
    cpu.cpuChain = await module.probeOcclusionEstimatesWithRayExtension(spec.probes, spec.options,
      module.createCpuReferenceExecutor(cpu.tlas));
    const aggregate = compareEstimates(spec, cpu, backend);
    const degradedOk = backend !== undefined && backend.degradedReason === null
      && cpu.cpuChain.extension.degradedReason === undefined;
    const overflowOk = backend !== undefined && backend.stackOverflows === 0;
    const webgpuRan = Boolean(backend);
    gate &&= rawComparison.passed && rawAnalytic.passed && aggregate.passed && statsGate(aggregate)
      && degradedOk && overflowOk && webgpuRan;
    caseResults.push({
      name: spec.name, kind: "probe-occlusion-two-level-tlas", note: spec.note,
      probeCount: spec.probes.length, dispatchedProbes: backend?.dispatchedProbes ?? cpu.batch.dispatched.length,
      rayCount: backend?.rayCount ?? cpu.batch.query.tMax.length,
      directionCount: cpu.resolved.directionCount, maxDistance: cpu.resolved.maxDistance,
      occluderMask: cpu.resolved.occluderMask, budgetClamped: backend?.clamped ?? cpu.batch.clamped,
      inputSha256: {
        inputs: sha256(Buffer.from(JSON.stringify({ probes: spec.probes, options: spec.options }))),
        instances: spec.instances.map((instance) => ({ id: instance.id,
          vertices: sha256(instance.blas.vertices.buffer), indices: sha256(instance.blas.indices.buffer) })),
      },
      cpuHitBufferSha256: sha256(cpu.gpuShape),
      gpuHitBufferSha256: gpuBuffer.byteLength > 0 ? sha256(gpuBuffer.buffer) : null,
      hitBufferBitwiseEqual: gpuBuffer.byteLength > 0
        ? Buffer.compare(Buffer.from(cpu.gpuShape), Buffer.from(gpuBuffer)) === 0 : null,
      rawComparison: { passed: rawComparison.passed, mismatchCount: rawComparison.mismatchCount,
        maxRelativeTDelta: rawComparison.maxRelativeTDelta, firstMismatches: rawComparison.firstMismatches },
      rawAnalytic: { passed: rawAnalytic.passed, mismatchCount: rawAnalytic.mismatchCount,
        maxRelativeTDelta: rawAnalytic.maxRelativeTDelta, firstMismatches: rawAnalytic.firstMismatches },
      aggregate,
      extensionStats: { gpu: backend ? { dispatchedProbes: backend.dispatchedProbes,
          dispatchedRays: backend.rayCount, clamped: backend.clamped,
          directionCount: backend.directionCount, occluderMask: backend.occluderMask,
          degradedReason: backend.degradedReason } : null,
        cpu: { dispatchedProbes: cpu.cpuChain.extension.dispatchedProbes,
          dispatchedRays: cpu.cpuChain.extension.dispatchedRays,
          clamped: cpu.cpuChain.extension.budgetClamped,
          directionCount: cpu.cpuChain.extension.directionCount,
          occluderMask: cpu.resolved.occluderMask,
          degradedReason: cpu.cpuChain.extension.degradedReason ?? null } },
      stackOverflows: backend?.stackOverflows ?? null,
      validationMessages: probe.validationMessages,
      firstRawRecords: backend?.firstRawRecords ?? [],
      cpuSanity: backend?.cpuSanity ?? [],
      webgpuRan,
    });
    await writeFile(path.join(outputDirectory, "inputs", `${spec.name}.hits.cpu.bin`),
      Buffer.from(cpu.gpuShape));
    if (gpuBuffer.byteLength > 0) {
      await writeFile(path.join(outputDirectory, "outputs", `${spec.name}.hits.webgpu.bin`),
        Buffer.from(gpuBuffer));
    }
  }

  function statsGate(aggregate) { return aggregate.statsAgreement; }

  const webgpuAvailable = Object.keys(probe.cases ?? {}).length > 0;
  const evidence = {
    schema: "probe-occlusion-gpu-evidence-v1",
    lane: "ray-backend-fourth-consumer-probe-occlusion-gpu-leg", createdAt: new Date().toISOString(),
    kernel: { name: "ray_trace_tlas_batch (two-level TLAS->BLAS)", entryPoint: module.RAY_TRACE_TLAS_ENTRY_POINT,
      workgroupSizeX: 64, stackCapacity: 32, instanceStrideBytes: 128,
      tolerance: { tRelative: T_RELATIVE_TOLERANCE, meanRelative: MEAN_RELATIVE_TOLERANCE,
        varianceRelative: VARIANCE_RELATIVE_TOLERANCE, missRatio: "exact", buried: "exact" } },
    artifacts: { wgsl: { sha256: sha256(await readFile(path.join(outputDirectory, "rayTraceTlasBatch.wgsl"))),
      consumers: ["webgpu-dawn-headless", "native-wgpu-pending"] } },
    environment: {
      chromeVersion: probe.browserVersion ?? null, userAgent: probe.userAgent ?? null,
      adapter: probe.adapter ?? null, features: probe.features ?? [],
      kernelValidationMessages: probe.validationMessages ?? [], compilationMessages: probe.compilationMessages ?? [],
      probeErrors: probe.errors,
    },
    cases: caseResults,
    verdict: {
      webgpuAvailable, cpuGpuAgreement: gate,
      notes: [
        "CPU 参考与浏览器腿共用同一 esbuild bundle（固定场景/探针-方向批次构造/TLAS 构建/两级执行器/CPU 参考与聚合单一来源，防口径分叉）。",
        "浏览器腿走完整 API 路径：probeOcclusionEstimatesWithRayExtension（主开关 → 探针 fail-fast → 每帧预算钳制 → RayTraceGpuTlasExecutor 两级真实 dispatch → 读回 → 聚合），另独立原始 traceBatch 供逐射线仲裁。",
        "三层仲裁：① 逐射线 compareTlasGpuAgainstCpu（命中/缺席一致 + instanceIndex/primitiveIndex 精确 + t 相对 1e-5）且 GPU/CPU 各自对解析闭式 t 同容差；② 聚合统计 GPU 估计 vs CPU 估计 vs 解析——missRatio/visibilityFloor/buried 精确相等，meanDistance/nearestHitDistance 相对 1e-5，distanceVariance 相对 1e-4（f32 量化级；t 的 f32/f64 差约 1e-7，经均值/方差传播仍低于容差约两个量级）；③ 解析遮挡率闭式锚点：封闭壳全命中（1）、头顶平板 Fibonacci 上半球 4/8 命中（0.5）、开阔探针全 miss（0，meanDistance = maxDistance 开放语义）、tiny 壳 mean ≤ 0.01 → buried（掩码案例被滤除后退化为 0.5 且 buried 翻转）。",
        "几何数值纪律：全部顶点 f32 精确（整数与 2^-9 半幅——12±2^-9 = 2048 ULP，ULP=2^-20；f32 不精确的微幅偏移会让顶点打包误差被短行程放大，真机实测 0.002 半幅产生 7.25e-5 的 t 相对偏差后改 dyadic）；解析命中距离与 tMax 严禁压边界——平板底面 y=3 使最大解析命中 t=3/0.125=24，与 tMax=32 分离 25%（真机实测 4/0.125=32 恰压边界时 f32 归一化翻转命中判定）；上行射线最大水平位移 23.8 < 平板半幅 40（解析命中不受 footprint 截断）；开阔探针距所有遮挡体最近点 ≥ 41.7 > 32（全 miss 闭合）；三角形相交双面语义（|det| 拒绝仅限退化），解析不依赖绕向。",
        "预算钳制案例（scene-budget-clamp）：6 探针 × 4 方向、maxRaysPerFrame=16 → 前缀 4 探针派发，尾部 2 探针双侧估计必须 undefined（fail-closed 前缀截断）；双腿扩展统计（派发数/射线数/钳制旗标/方向数/mask）一致。",
        "诚实边界：occlusionFloor/meanDistance/variance 到 packIrradianceProbeRecord 的编码写入与捕获调度侧消费接线不在本腿（批次 F）；native wgpu RT 腿 pending；本腿不修改 webgpu/probeClipmapRuntime 与 lighting/（只读合同）。",
      ],
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  const formatCase = (entry) => `${entry.name}: probes=${entry.probeCount} dispatched=${entry.dispatchedProbes} rays=${entry.rayCount} ` +
    `raw=${entry.rawComparison.passed} analytic=${entry.rawAnalytic.passed} ` +
    `maxRelT=${Math.max(entry.rawComparison.maxRelativeTDelta, entry.rawAnalytic.maxRelativeTDelta).toExponential(3)} ` +
    `aggregate=${entry.aggregate.passed} bitwise=${entry.hitBufferBitwiseEqual} overflow=${entry.stackOverflows} ` +
    `clamped=${entry.budgetClamped}`;
  const summary = caseResults.map(formatCase);
  const perProbeLines = caseResults.flatMap((entry) => entry.aggregate.perProbe.map((line) =>
    `  ${entry.name}/${line.label}: miss=${line.gpu?.missRatio ?? "-"} mean=${line.gpu?.meanDistance ?? "-"} ` +
    `var=${line.gpu?.distanceVariance ?? "-"} nearest=${line.gpu?.nearestHitDistance ?? "-"} ` +
    `buried=${line.gpu?.buried ?? "-"} passed=${line.passed ?? line.clampedAway}`));
  console.log([...summary, ...perProbeLines].join("\n"));
  console.log(`WebGPU available: ${webgpuAvailable}; CPU/GPU agreement verdict: ${gate ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!gate) process.exitCode = 1;
}

await main();
