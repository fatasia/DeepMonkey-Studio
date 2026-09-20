import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// RayBackend WGSL 软件执行器真机对拍 runner（波次4 单级 + TLAS 两级扩展；模式沿用 r2ShaderIrGpuTest.mjs）。
// headless Chrome + WebGPU 走完整 API 路径（执行器打包 → dispatch → 读回），与 CPU 参考
// 实现（单级 rayTrace.traceClosest / 两级 tlas.traceTlasClosest，同 bundle 单一来源）逐射线
// 对拍：命中/缺席一致、primitiveIndex/instanceIndex 精确相等、t 相对容差 1e-5。
// 证据写入 test-output/ray-trace-gpu-20260920-r2/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "ray-trace-gpu-20260920-r2");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.RAY_TRACE_GPU_TEST_ATTEMPTS ?? 3);

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
      return module.runRayTraceGpuProbe(caseRequests);
    }, requests);
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "ray-trace-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/rayTraceGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  const module = await import(pathToFileURL(bundlePath));
  await writeFile(path.join(bundleDirectory, "probe.html"), `<!doctype html><title>Ray trace GPU probe</title>`);

  const casesSpec = module.buildRayTraceCases();
  const tlasCasesSpec = module.buildRayTraceTlasCases();
  const requests = casesSpec.map((spec) => ({
    name: spec.name,
    verticesBase64: Buffer.from(spec.blas.vertices.buffer, spec.blas.vertices.byteOffset, spec.blas.vertices.byteLength).toString("base64"),
    indicesBase64: Buffer.from(spec.blas.indices.buffer, spec.blas.indices.byteOffset, spec.blas.indices.byteLength).toString("base64"),
    originsBase64: Buffer.from(spec.rays.origins.buffer, spec.rays.origins.byteOffset, spec.rays.origins.byteLength).toString("base64"),
    directionsBase64: Buffer.from(spec.rays.directions.buffer, spec.rays.directions.byteOffset, spec.rays.directions.byteLength).toString("base64"),
    tMaxBase64: Buffer.from(spec.rays.tMax.buffer, spec.rays.tMax.byteOffset, spec.rays.tMax.byteLength).toString("base64"),
  }));
  const tlasRequests = tlasCasesSpec.map((spec) => ({
    name: spec.name,
    instances: spec.instances.map((instance) => ({
      id: instance.id,
      verticesBase64: Buffer.from(instance.blas.vertices.buffer, instance.blas.vertices.byteOffset, instance.blas.vertices.byteLength).toString("base64"),
      indicesBase64: Buffer.from(instance.blas.indices.buffer, instance.blas.indices.byteOffset, instance.blas.indices.byteLength).toString("base64"),
      worldToLocal: [...instance.worldToLocal],
      mask: instance.mask,
    })),
    originsBase64: Buffer.from(spec.rays.origins.buffer, spec.rays.origins.byteOffset, spec.rays.origins.byteLength).toString("base64"),
    directionsBase64: Buffer.from(spec.rays.directions.buffer, spec.rays.directions.byteOffset, spec.rays.directions.byteLength).toString("base64"),
    tMaxBase64: Buffer.from(spec.rays.tMax.buffer, spec.rays.tMax.byteOffset, spec.rays.tMax.byteLength).toString("base64"),
    mask: spec.rays.mask,
  }));
  // CPU 参考（Node 侧，同一 bundle 单一来源）：命中/缺席、primitiveIndex、t 全量预算。
  const references = new Map(casesSpec.map((spec) => {
    const scene = module.buildTracedScene(spec.blas);
    const queries = module.batchQueryToQueries(spec.rays);
    const hits = queries.map((query) => module.traceClosest(scene, query));
    return [spec.name, { scene, queries, hits, gpuShape: module.encodeGpuHits(hits) }];
  }));
  const tlasReferences = new Map(tlasCasesSpec.map((spec) => {
    const tlas = module.buildTlas(spec.instances);
    const queries = module.batchQueryToQueries(spec.rays);
    const hits = queries.map((query) => module.traceTlasClosest(tlas, query, spec.rays.mask));
    const packed = module.packTlasScene(tlas);
    return [spec.name, { tlas, queries, hits, packed, gpuShape: module.encodeGpuTlasHits(hits) }];
  }));

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin, [...requests, ...tlasRequests]);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { errors: [String(error instanceof Error ? error.message : error)], cases: {} };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  await mkdir(path.join(outputDirectory, "inputs"), { recursive: true });
  await mkdir(path.join(outputDirectory, "outputs"), { recursive: true });
  const wgsl = module.emitRayTraceKernelWgsl();
  await writeFile(path.join(outputDirectory, "rayTraceBatch.wgsl"), wgsl);
  const tlasWgsl = module.emitTwoLevelRayTraceKernelWgsl();
  await writeFile(path.join(outputDirectory, "rayTraceTlasBatch.wgsl"), tlasWgsl);

  const caseResults = [];
  const tlasCaseResults = [];
  const totalCases = casesSpec.length + tlasCasesSpec.length;
  let gate = Boolean(probe.cases) && Object.keys(probe.cases).length === totalCases;
  for (const spec of casesSpec) {
    const prepared = references.get(spec.name);
    const backend = probe.cases?.[spec.name];
    const gpuBuffer = backend ? base64ToBytes(backend.hitsBase64) : new Uint8Array(0);
    const gpuHits = backend && gpuBuffer.byteLength > 0 ? module.decodeGpuHits(gpuBuffer.buffer.slice(0)) : [];
    const comparison = gpuHits.length > 0
      ? module.compareGpuAgainstCpu(prepared.scene, prepared.queries, gpuHits)
      : { rayCount: spec.rays.tMax.length, passed: false, mismatchCount: -1, maxRelativeTDelta: -1,
        firstMismatches: ["backend case missing"] };
    const hitCount = gpuHits.filter((hit) => hit !== undefined).length;
    const caseResult = {
      name: spec.name, kind: "single-blas", note: spec.note, rayCount: spec.rays.tMax.length, gpuHitCount: hitCount,
      inputSha256: {
        vertices: sha256(spec.blas.vertices.buffer), indices: sha256(spec.blas.indices.buffer),
        origins: sha256(spec.rays.origins.buffer), directions: sha256(spec.rays.directions.buffer),
        tMax: sha256(spec.rays.tMax.buffer),
      },
      cpuHitBufferSha256: sha256(prepared.gpuShape),
      gpuHitBufferSha256: gpuBuffer.byteLength > 0 ? sha256(gpuBuffer.buffer) : null,
      hitBufferBitwiseEqual: gpuBuffer.byteLength > 0
        ? Buffer.compare(Buffer.from(prepared.gpuShape), Buffer.from(gpuBuffer)) === 0 : null,
      comparison: { passed: comparison.passed, mismatchCount: comparison.mismatchCount,
        maxRelativeTDelta: comparison.maxRelativeTDelta, firstMismatches: comparison.firstMismatches },
      stackOverflows: backend?.stackOverflows ?? null,
      validationMessages: backend?.validationMessages ?? [],
      firstRawRecords: backend?.firstRawRecords ?? [],
      cpuSanity: backend?.cpuSanity ?? [],
      webgpuRan: Boolean(backend),
    };
    gate &&= comparison.passed && backend?.stackOverflows === 0 && probe.errors.length === 0;
    caseResults.push(caseResult);
    await writeFile(path.join(outputDirectory, "inputs", `${spec.name}.hits.cpu.bin`), Buffer.from(prepared.gpuShape));
    if (gpuBuffer.byteLength > 0) {
      await writeFile(path.join(outputDirectory, "outputs", `${spec.name}.hits.webgpu.bin`), Buffer.from(gpuBuffer));
    }
  }

  for (const spec of tlasCasesSpec) {
    const prepared = tlasReferences.get(spec.name);
    const backend = probe.cases?.[spec.name];
    const gpuBuffer = backend ? base64ToBytes(backend.hitsBase64) : new Uint8Array(0);
    const gpuHits = backend && gpuBuffer.byteLength > 0 ? module.decodeGpuTlasHits(gpuBuffer.buffer.slice(0)) : [];
    const comparison = gpuHits.length > 0
      ? module.compareTlasGpuAgainstCpu(prepared.tlas, prepared.queries, gpuHits, prepared.packed.placements, spec.rays.mask)
      : { rayCount: spec.rays.tMax.length, passed: false, mismatchCount: -1, maxRelativeTDelta: -1,
        firstMismatches: ["backend case missing"] };
    const hitCount = gpuHits.filter((hit) => hit !== undefined).length;
    const caseResult = {
      name: spec.name, kind: "two-level-tlas", note: spec.note, rayCount: spec.rays.tMax.length,
      instanceCount: backend?.instanceCount ?? prepared.packed.instanceCount, gpuHitCount: hitCount,
      inputSha256: {
        instances: spec.instances.map((instance) => ({ id: instance.id,
          vertices: sha256(instance.blas.vertices.buffer), indices: sha256(instance.blas.indices.buffer) })),
        origins: sha256(spec.rays.origins.buffer), directions: sha256(spec.rays.directions.buffer),
        tMax: sha256(spec.rays.tMax.buffer),
      },
      cpuHitBufferSha256: sha256(prepared.gpuShape),
      gpuHitBufferSha256: gpuBuffer.byteLength > 0 ? sha256(gpuBuffer.buffer) : null,
      hitBufferBitwiseEqual: gpuBuffer.byteLength > 0
        ? Buffer.compare(Buffer.from(prepared.gpuShape), Buffer.from(gpuBuffer)) === 0 : null,
      comparison: { passed: comparison.passed, mismatchCount: comparison.mismatchCount,
        maxRelativeTDelta: comparison.maxRelativeTDelta, firstMismatches: comparison.firstMismatches },
      stackOverflows: backend?.stackOverflows ?? null,
      validationMessages: backend?.validationMessages ?? [],
      firstRawRecords: backend?.firstRawRecords ?? [],
      cpuSanity: backend?.cpuSanity ?? [],
      webgpuRan: Boolean(backend),
    };
    gate &&= comparison.passed && backend?.stackOverflows === 0;
    tlasCaseResults.push(caseResult);
    await writeFile(path.join(outputDirectory, "inputs", `${spec.name}.hits.cpu.bin`), Buffer.from(prepared.gpuShape));
    if (gpuBuffer.byteLength > 0) {
      await writeFile(path.join(outputDirectory, "outputs", `${spec.name}.hits.webgpu.bin`), Buffer.from(gpuBuffer));
    }
  }

  const webgpuAvailable = Object.keys(probe.cases ?? {}).length > 0;
  const evidence = {
    schema: "ray-trace-gpu-evidence-v1",
    lane: "wave4-software-ray-tracing + tlas-two-level", createdAt: new Date().toISOString(),
    kernel: { name: "ray_trace_batch", entryPoint: "ray_trace_batch",
      workgroupSizeX: 64, stackCapacity: 32, tolerance: { tRelative: 1e-5, primitiveIndex: "exact" } },
    kernelTwoLevel: { name: "ray_trace_tlas_batch", entryPoint: "ray_trace_tlas_batch",
      workgroupSizeX: 64, stackCapacity: 32, instanceStrideBytes: 128,
      tolerance: { tRelative: 1e-5, primitiveIndex: "exact", instanceIndex: "exact" } },
    artifacts: {
      wgsl: { sha256: sha256(await readFile(path.join(outputDirectory, "rayTraceBatch.wgsl"))),
        consumers: ["webgpu-dawn", "native-wgpu-pending"] },
      wgslTlas: { sha256: sha256(await readFile(path.join(outputDirectory, "rayTraceTlasBatch.wgsl"))),
        consumers: ["webgpu-dawn", "native-wgpu-pending"] },
    },
    environment: {
      chromeVersion: probe.browserVersion ?? null, userAgent: probe.userAgent ?? null,
      adapter: probe.adapter ?? null, features: probe.features ?? [], probeErrors: probe.errors,
    },
    cases: [...caseResults, ...tlasCaseResults],
    verdict: {
      webgpuAvailable,
      cpuGpuAgreement: gate,
      notes: [
        "CPU 参考与浏览器腿共用同一 esbuild bundle（buildTracedScene/traceClosest/buildTlas/traceTlasClosest/执行器单一来源，防口径分叉）。",
        "对拍合同：命中/缺席逐射线一致 + primitiveIndex/instanceIndex 精确相等 + t 相对容差 1e-5；另记录 16B HitRecord 缓冲逐位比较作证据（非门槛）。",
        "单级 ray_trace_batch 与两级 ray_trace_tlas_batch（TLAS 盒剪枝→逆仿射→BLAS 遍历→世界空间最近 t）；native wgpu RT 腿属后续波次。",
        "栈深上限 32 fail-closed：单级/两级 stackOverflows 哨兵非零即整批拒绝，本门槛要求全案例为 0。",
        "两级 primitiveIndex 为拼接后全局三角下标（tlasLayout 拼接合同）；单级语义不变。",
      ],
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  const formatCase = (entry) => `${entry.name}: rays=${entry.rayCount} hits=${entry.gpuHitCount} ` +
    `passed=${entry.comparison.passed} maxRelT=${entry.comparison.maxRelativeTDelta} ` +
    `bitwise=${entry.hitBufferBitwiseEqual} overflow=${entry.stackOverflows}`;
  const summary = [...caseResults, ...tlasCaseResults].map(formatCase);
  console.log(summary.join("\n"));
  console.log(`WebGPU available: ${webgpuAvailable}; CPU/GPU agreement verdict: ${gate ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!gate) process.exitCode = 1;
}

await main();
