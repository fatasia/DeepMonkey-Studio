import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// R2 跨后端着色 IR 真机对拍 runner（设计: docs/specs/r2-shader-ir-design-2026-09-19.md §6）。
// 单一 DCIR 源 → WGSL(WebGPU) 与 GLSL(WebGL2) 在同一 headless Chrome 内真实执行,
// 与 CPU 参考实现三方对拍; 证据写入 test-output/r2-shader-ir-20260919-r1/。
// 与并行确定性重放测试错峰: 失败自动重试(4s 间隔), 每案例 GPU 用时毫秒级。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "r2-shader-ir-20260919-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.R2_GPU_TEST_ATTEMPTS ?? 3);

const CASES = [
  { name: "pow2-64x64-min", seed: 0x5eed_0001, width: 64, height: 64, reduceMax: false, tier: "bitwise" },
  { name: "npot-37x23-min", seed: 0x5eed_0002, width: 37, height: 23, reduceMax: false, tier: "bitwise" },
  { name: "npot-13x7-max", seed: 0x5eed_0003, width: 13, height: 7, reduceMax: true, tier: "bitwise" },
  { name: "tiny-1x1-min", seed: 0x5eed_0004, width: 1, height: 1, reduceMax: false, tier: "bitwise" },
  { name: "denormal-17x9-min", seed: 0x5eed_0005, width: 17, height: 9, reduceMax: false, tier: "denormal-probe" },
];

const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const base64ToBytes = (value) => Uint8Array.from(Buffer.from(value, "base64"));

/** f32 位型的单调键（±0 视为相等）；NaN 不参与（确定性合同禁止 NaN 进入逐位档）。 */
function orderedKey(bits) {
  if (bits === 0x8000_0000) return 1;
  const magnitude = bits & 0x7fff_ffff;
  return (bits >>> 31) === 0 ? magnitude + 1 : -(magnitude + 1);
}

function compareOutputs(a, b) {
  const bitsA = new Uint32Array(a.buffer), bitsB = new Uint32Array(b.buffer);
  let mismatches = 0, maxAbs = 0, maxUlp = 0;
  // ±inf 参与 max 案例：同值视为 0 差，不同类别记 Infinity（避免 NaN 污染统计）。
  const absDiff = (x, y) => (Number.isFinite(x) && Number.isFinite(y)) ? Math.abs(x - y) : (x === y ? 0 : Infinity);
  for (let index = 0; index < bitsA.length; index++) {
    const valueA = a[index], valueB = b[index];
    if (bitsA[index] !== bitsB[index]) mismatches++;
    maxAbs = Math.max(maxAbs, absDiff(valueA, valueB));
    maxUlp = Math.max(maxUlp, Math.abs(orderedKey(bitsA[index]) - orderedKey(bitsB[index])));
  }
  return { bitwiseEqual: mismatches === 0, mismatches, maxAbsDiff: maxAbs, maxUlpDiff: maxUlp };
}

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
      return module.runR2ShaderIrProbe(caseRequests);
    }, requests);
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "r2-shader-ir-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/r2ShaderIrProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  const module = await import(pathToFileURL(bundlePath));
  // min/max 两模式在 IR 层特化（ANGLE/D3D11 对 uvec2+uint 混排 uniform 的打包 quirk，见 evidence notes）。
  const kernels = { min: module.buildHiZFirstStageKernel(false), max: module.buildHiZFirstStageKernel(true) };
  const wgsl = { min: module.emitKernelWgsl(kernels.min), max: module.emitKernelWgsl(kernels.max) };
  const glsl = { min: module.emitKernelGlsl(kernels.min), max: module.emitKernelGlsl(kernels.max) };

  const requests = [];
  const references = new Map();
  for (const entry of CASES) {
    const input = module.generateHiZInput(entry.seed, entry.width, entry.height,
      entry.tier === "denormal-probe" ? { denormal: true } : {});
    const [tw, th] = module.hiZFirstStageTargetSize(entry.width, entry.height);
    requests.push({ name: entry.name, sourceWidth: entry.width, sourceHeight: entry.height,
      reduceMax: entry.reduceMax, inputBase64: Buffer.from(input.buffer).toString("base64") });
    references.set(entry.name, { input, reference: module.referenceHiZFirstStage(input, entry.width, entry.height, entry.reduceMax), tw, th });
  }
  await writeFile(path.join(bundleDirectory, "probe.html"), `<!doctype html><title>R2 shader IR probe</title>`);

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin, requests);
      if (probe.errors.length === 0 || probe.webgpu && probe.webgl) break;
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  await mkdir(path.join(outputDirectory, "inputs"), { recursive: true });
  await mkdir(path.join(outputDirectory, "outputs"), { recursive: true });
  for (const mode of ["min", "max"]) {
    await writeFile(path.join(outputDirectory, `hiZFirstStage.${mode}.wgsl`), wgsl[mode].code);
    await writeFile(path.join(outputDirectory, `hiZFirstStage.${mode}.frag.glsl`), glsl[mode].fragment);
  }
  await writeFile(path.join(outputDirectory, "hiZFirstStage.vert.glsl"), glsl.min.vertex);

  const cases = [];
  let bitwiseGate = probe.webgpu !== undefined && probe.webgl !== undefined;
  for (const entry of CASES) {
    const prepared = references.get(entry.name);
    const webgpu = probe.webgpu?.cases[entry.name];
    const webgl = probe.webgl?.cases[entry.name];
    const mode = entry.reduceMax ? "max" : "min";
    const outputOf = (backend, repeat) => backend
      ? new Float32Array(base64ToBytes(backend.repeatsBase64[repeat]).buffer.slice(0)) : undefined;
    const wgslOut = [outputOf(webgpu, 0), outputOf(webgpu, 1)];
    const glslOut = [outputOf(webgl, 0), outputOf(webgl, 1)];
    const compare = (a, b) => a && b ? compareOutputs(a, b) : null;
    const crossBackend = compare(wgslOut[0], glslOut[0]);
    const caseResult = {
      name: entry.name, tier: entry.tier,
      sourceSize: [entry.width, entry.height], targetSize: [prepared.tw, prepared.th], reduceMax: entry.reduceMax,
      inputSha256: sha256(prepared.input.buffer), referenceSha256: sha256(prepared.reference.buffer),
      webgpu: { available: Boolean(webgpu), repeatStable: compare(wgslOut[0], wgslOut[1])?.bitwiseEqual ?? null,
        outputSha256: wgslOut[0] ? sha256(wgslOut[0].buffer) : null,
        validationMessages: webgpu?.validationMessages ?? [] },      webgl: { available: Boolean(webgl), repeatStable: compare(glslOut[0], glslOut[1])?.bitwiseEqual ?? null,
        outputSha256: glslOut[0] ? sha256(glslOut[0].buffer) : null, glError: webgl?.glError ?? null,
        otherChannelMaxAbs: webgl?.otherChannelMaxAbs ?? null, uniformEcho: webgl?.uniformEcho ?? null,
        uniformShaderEcho: webgl?.uniformShaderEcho ?? null },
      crossBackend: crossBackend,
      vsReference: { webgpu: compare(wgslOut[0], prepared.reference), webgl: compare(glslOut[0], prepared.reference) },
    };
    if (entry.tier === "bitwise") {
      bitwiseGate &&= Boolean(crossBackend?.bitwiseEqual && caseResult.webgpu.repeatStable && caseResult.webgl.repeatStable
        && caseResult.vsReference.webgpu?.bitwiseEqual && caseResult.vsReference.webgl?.bitwiseEqual);
    }
    caseResult.mode = mode;
    cases.push(caseResult);
    await writeFile(path.join(outputDirectory, "inputs", `${entry.name}.f32.bin`), Buffer.from(prepared.input.buffer));
    await writeFile(path.join(outputDirectory, "inputs", `${entry.name}.reference.f32.bin`), Buffer.from(prepared.reference.buffer));
    if (wgslOut[0]) await writeFile(path.join(outputDirectory, "outputs", `${entry.name}.webgpu.f32.bin`), Buffer.from(wgslOut[0].buffer));
    if (glslOut[0]) await writeFile(path.join(outputDirectory, "outputs", `${entry.name}.webgl.f32.bin`), Buffer.from(glslOut[0].buffer));
  }

  const evidence = {
    schema: "r2-shader-ir-evidence-v1",
    lane: "R2", createdAt: new Date().toISOString(),
    kernel: {
      name: "hi_z_first_stage", dcirSchema: 1, workgroupSize: [8, 8],
      irSha256: { min: wgsl.min.irSha256, max: wgsl.max.irSha256 },
      modeSpecialization: "min/max 在 IR 层特化；ANGLE/D3D11 对『两个 uvec2 + 一个 uint』uniform 打包存在 quirk（uint 恒读 0），特化后仅剩两个 uvec2 uniform，双端真机证实正确",
    },
    artifacts: {
      wgsl: {
        min: { sha256: sha256(await readFile(path.join(outputDirectory, "hiZFirstStage.min.wgsl"))), consumers: ["webgpu-dawn", "native-wgpu-pending"] },
        max: { sha256: sha256(await readFile(path.join(outputDirectory, "hiZFirstStage.max.wgsl"))), consumers: ["webgpu-dawn", "native-wgpu-pending"] },
      },
      glslFragment: {
        min: { sha256: sha256(await readFile(path.join(outputDirectory, "hiZFirstStage.min.frag.glsl"))), consumer: "webgl2-angle" },
        max: { sha256: sha256(await readFile(path.join(outputDirectory, "hiZFirstStage.max.frag.glsl"))), consumer: "webgl2-angle" },
      },
      glslVertex: { sha256: sha256(await readFile(path.join(outputDirectory, "hiZFirstStage.vert.glsl"))), consumer: "webgl2-angle" },
    },
    environment: {
      chromeVersion: probe.browserVersion ?? null,
      userAgent: probe.userAgent ?? null,
      webgpu: probe.webgpu ? { adapter: probe.webgpu.adapter, features: probe.webgpu.features } : null,
      webgl: probe.webgl ? { version: probe.webgl.version, unmaskedRenderer: probe.webgl.unmaskedRenderer,
        unmaskedVendor: probe.webgl.unmaskedVendor, floatRenderable: probe.webgl.floatRenderable } : null,
      probeErrors: probe.errors,
    },
    cases,
    verdict: {
      wgslVsGlslBitwise: bitwiseGate,
      nativeWgpu: "not-connected (see src/shaderCompute/nativeHarness.ts)",
      notes: ["CPU 参考实现与两后端同语义;denormal 案例为阈值档风险探针,不参与逐位判定。",
        "NPOT 首档语义为 2×2 锚定块,与生产 HI_Z_REDUCE_WGSL 变窗公式不同(设计 §5/§8)。",
        "uniformShaderEcho 为 ANGLE/D3D11 uniform 打包 quirk 的诊断证据(uvec2/uint 混排时部分 uniform 不进 shader),已用 IR 级模式特化规避。"],
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  const summary = cases.map((entry) => `${entry.name}: cross=${entry.crossBackend?.bitwiseEqual ?? "n/a"} ref=${entry.vsReference.webgpu?.bitwiseEqual ?? "n/a"}/${entry.vsReference.webgl?.bitwiseEqual ?? "n/a"} maxUlp=${entry.crossBackend?.maxUlpDiff ?? "n/a"}`);
  console.log(summary.join("\n"));
  if (!bitwiseGate) {
    console.error("Bitwise tier verdict FAILED; see evidence.json.");
    process.exitCode = 1;
  } else {
    console.log(`Bitwise tier verdict PASSED; evidence: ${outputDirectory}`);
  }
}

await main();
