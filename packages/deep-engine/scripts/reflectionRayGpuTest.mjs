import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// 反射 closest-hit 帧通道 GPU 探针 runner(B3 光追双通道·reflection 二通道验收门;
// harness 沿用 shadowRayGpuTest.mjs)。headless Chrome + WebGPU 完整 API 路径:
// 真实深度 pass → RayTraceClosestFramePass(持久场景缓冲 → dispatch)→ 读回仲裁。
// 门:① GPU 命中记录 == CPU 参考(traceTlasClosest 仲裁:hit/miss 逐像素恒等 +
//      t 相对差 ≤ 2e-3 + 法线点积 ≥ 1−1e-3;深度取 GPU 读回同值消除光栅精度差)
//    ② f16 档记录 == f32 档记录(逐位)
//    ③ 栈溢出哨兵 == 0(fail-closed 不可达)
//    ④ perf 仅记录(wall=encode+submit 入队,帧通道无 timestamp 支持,如实标注不作门)。
// 证据写 test-output/reflection-ray-gpu-20261005/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "reflection-ray-gpu-20261005");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.REFLECTION_RAY_GPU_TEST_ATTEMPTS ?? 3);
const T_REL_TOLERANCE = 2e-3, T_ABS_FLOOR = 1e-4, NORMAL_DOT_FLOOR = 1 - 1e-3;

const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const base64ToBytes = (value) => Uint8Array.from(Buffer.from(value, "base64"));

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method === "GET" && ["probe.html", "probe.bundle.mjs"].includes(name)) {
      response.writeHead(200, { "Content-Type": name.endsWith(".html")
        ? "text/html; charset=utf-8" : "text/javascript" })
        .end(await readFile(path.join(directory, name)));
      return;
    }
    response.writeHead(404).end();
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
      return module.runReflectionRayGpuProbe();
    });
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

/** 记录逐像素对拍(hit/miss 恒等 + t 相对差 + 法线点积);返回首个失配样本供证据。 */
function parityArbitration(gpuRecords, cpuRecords) {
  const pixels = gpuRecords.length / 4;
  let identityMismatches = 0, tMismatches = 0, normalMismatches = 0, hits = 0;
  let firstMismatch = null;
  for (let px = 0; px < pixels; px++) {
    const g = px * 4, gpuT = gpuRecords[g], cpuT = cpuRecords[g];
    const gpuHit = gpuT >= 0, cpuHit = cpuT >= 0;
    if (!cpuHit && !gpuHit) continue;
    if (cpuHit !== gpuHit) {
      identityMismatches++;
      firstMismatch ??= { pixel: px, kind: "identity", gpu: [...gpuRecords.slice(g, g + 4)],
        cpu: [...cpuRecords.slice(g, g + 4)] };
      continue;
    }
    hits++;
    // t 容差 = max(相对 2e-3, 绝对 1e-4):贴边掠射命中的近零 t 上 f32/f64 天然发散
    // (真机实测 Δt≈1.4e-6 @ t≈1.5e-4,相对差 9e-3);绝对下限远小于 bias=0.01,
    // 对任何着色相关距离无影响 —— 容差标定,非放门。
    const tError = Math.abs(gpuT - cpuT);
    if (!(tError <= Math.max(T_REL_TOLERANCE * Math.abs(cpuT), T_ABS_FLOOR))) {
      tMismatches++;
      firstMismatch ??= { pixel: px, kind: "t", gpu: [...gpuRecords.slice(g, g + 4)],
        cpu: [...cpuRecords.slice(g, g + 4)] };
    }
    const dot = gpuRecords[g + 1] * cpuRecords[g + 1] + gpuRecords[g + 2] * cpuRecords[g + 2]
      + gpuRecords[g + 3] * cpuRecords[g + 3];
    if (!(dot >= NORMAL_DOT_FLOOR)) {
      normalMismatches++;
      firstMismatch ??= { pixel: px, kind: "normal", gpu: [...gpuRecords.slice(g, g + 4)],
        cpu: [...cpuRecords.slice(g, g + 4)] };
    }
  }
  return { pixels, hits, identityMismatches, tMismatches, normalMismatches,
    parity: identityMismatches === 0 && tMismatches === 0 && normalMismatches === 0,
    ...(firstMismatch ? { firstMismatch } : {}) };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "reflection-ray-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/reflectionRayGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><title>Reflection closest-hit GPU probe</title>`);
  // Node 仲裁腿与浏览器腿共用同一 bundle(场景/相机/CPU 参考/WGSL 单一来源,防口径分叉)。
  const module = await import(pathToFileURL(bundlePath));

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
  const wgsl = module.emitRayTraceClosestFrameKernelWgsl();
  await writeFile(path.join(outputDirectory, "rayTraceClosestFrame.wgsl"), wgsl);

  const caseResults = [];
  let gate = probe.errors.length === 0 && Object.keys(probe.cases).length > 0;
  const f32Records = probe.cases?.f32
    ? new Float32Array(base64ToBytes(probe.cases.f32.recordsBase64).buffer) : null;
  const resolution = module.REFLECTION_RESOLUTION;
  for (const [name, backend] of Object.entries(probe.cases ?? {})) {
    const gpuRecords = new Float32Array(base64ToBytes(backend.recordsBase64).buffer);
    const depth = new Float32Array(base64ToBytes(backend.depthBase64).buffer);
    const cpuScene = module.buildReflectionScene(name === "f16");
    const reference = module.referenceReflectionRecords(cpuScene, depth, resolution, resolution,
      probe.invViewProjection, module.REFLECTION_EYE);
    const arbitration = parityArbitration(gpuRecords, reference.records);
    const f16Parity = name === "f16" && f32Records !== null
      ? gpuRecords.every((v, i) => v === f32Records[i]) : null;
    gate &&= arbitration.parity && backend.stackOverflows === 0 && (f16Parity === null || f16Parity);
    caseResults.push({
      variant: name, pixelCount: backend.pixelCount, cpuHits: reference.hits,
      gpuHits: arbitration.hits, identityMismatches: arbitration.identityMismatches,
      tMismatches: arbitration.tMismatches, normalMismatches: arbitration.normalMismatches,
      recordsEqualsCpu: arbitration.parity, tolerance: { tRelative: T_REL_TOLERANCE,
        tAbsoluteFloor: T_ABS_FLOOR, normalDotFloor: NORMAL_DOT_FLOOR },
      wallMs: Number(backend.wallMs.toFixed(3)), timingSource: "wall-enqueue(perf 不作门,证据)",
      f16Parity, stackOverflows: backend.stackOverflows,
      recordsSha256: sha256(base64ToBytes(backend.recordsBase64)),
      ...(arbitration.firstMismatch ? { firstMismatch: arbitration.firstMismatch } : {}),
    });
    await writeFile(path.join(outputDirectory, "outputs", `${name}.records.bin`),
      Buffer.from(gpuRecords.buffer));
  }

  const evidence = {
    schema: "reflection-ray-gpu-evidence-v1",
    lane: "compute-bvh-frame-channel/reflection-closest-hit(B3 光追双通道)",
    createdAt: new Date().toISOString(),
    kernel: { name: "ray_trace_closest_frame", entryPoint: "ray_trace_closest_frame",
      workgroupSizeX: 8, workgroupSizeY: 8, output: "rgba32float [t, normal.xyz]; miss=[-1,0,0,0]",
      semantics: "closest-hit reflection record channel (complementary to shadowRayFrameKernel any-hit)" },
    artifacts: {
      wgsl: { sha256: sha256(await readFile(path.join(outputDirectory, "rayTraceClosestFrame.wgsl"))),
        consumers: ["webgpu-dawn(frame channel;HDR 合成消费属下一切片)"] },
      f32Records: caseResults.find(c => c.variant === "f32")?.recordsSha256 ?? null,
    },
    environment: {
      chromeVersion: probe.browserVersion ?? null, userAgent: probe.userAgent ?? null,
      adapter: probe.adapter ?? null, features: probe.features, probeErrors: probe.errors,
      shaderF16: probe.shaderF16, timestampQuery: probe.timestampQuery,
    },
    scene: { resolution, tMax: module.REFLECTION_T_MAX, bias: module.REFLECTION_BIAS,
      instances: ["reflection-wall", "reflection-mirror-box", "reflection-lean-panel"],
      note: "CPU 参考消费 GPU 读回深度(与内核同 f32 值);深度光栅为探针内 depth-only pass。" },
    cases: caseResults,
    verdict: {
      gate,
      gates: {
        recordsEqualsCpu: caseResults.find(c => c.variant === "f32")?.recordsEqualsCpu ?? false,
        f16Parity: caseResults.find(c => c.variant === "f16")?.f16Parity ?? "skipped (no shader-f16)",
        stackOverflowsZero: caseResults.every(c => c.stackOverflows === 0) && caseResults.length > 0,
        perf: "evidence-only(帧通道 pass 无 timestamp 写入;wall=encode+submit 入队)",
      },
      notes: [
        "门① 三重:hit/miss 逐像素恒等 + t ≤ max(相对 2e-3, 绝对 1e-4) + 法线点积 ≥ 1−1e-3(traceTlasClosest CPU 仲裁)。",
        "深度输入取 GPU 深度纹理读回(与内核消费同一 f32 值),消除 CPU/GPU 光栅化精度差对恒等门的污染。",
        "GPU 命中 t 为 bias 偏移后行程(origin = p + reflect·bias);CPU 参考同式同值,逐像素可比。",
        "消费端(HDR/SSR 家族合成)接线属下一切片;本门锁定通道数值语义。",
      ],
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  for (const result of caseResults) {
    console.log(`${result.variant}: pixels=${result.pixelCount} cpuHits=${result.cpuHits} gpuHits=${result.gpuHits} ` +
      `identity✗=${result.identityMismatches} t✗=${result.tMismatches} normal✗=${result.normalMismatches} ` +
      `wall=${result.wallMs}ms f16parity=${result.f16Parity ?? "n/a"} overflows=${result.stackOverflows}`);
  }
  console.log(`Verdict: ${gate ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!gate) process.exitCode = 1;
}

await main();
