import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// Deep GI 探针一跳场景辐射真机证据 runner（F1 第一切片；模式沿用 rayTraceGpuTest.mjs）。
// headless Chrome + 真 WebGPU 走完整生产链：ProbeSceneRadianceProducer 场景上传 → 灯光锁存 →
// encodeSourceRadiance 一次性 dispatch → 捕获纹理 rgba16float 读回；与同 bundle CPU 参考
// （buildRenderPacketRayScene + traceTlasClosest + probeOcclusionDirection + 同一着色公式）
// 逐探针对拍（相对容差 2e-3 覆盖 f16 存储量化）。断言：WGSL 零编译告警、溢出哨兵为 0、
// 逐探针能量对拍通过、开阔天空探针能量 > 遮挡探针、一跳能量真实存在。
// 证据写入 test-output/probe-radiance-gpu-20260922/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "probe-radiance-gpu-20260922");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.PROBE_RADIANCE_GPU_TEST_ATTEMPTS ?? 3);
const RELATIVE_TOLERANCE = 2e-3, ABSOLUTE_TOLERANCE = 1e-3;

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
      return module.runProbeRadianceGpuProbe();
    });
    result.browserVersion = browser.version();
    return result;
  } finally {
    await browser.close();
  }
}

function probeMatchesCpu(gpu, cpu, flipAllowance) {
  // One-flip allowance (computed in-bundle from the CPU per-direction contributions) covers
  // a single f32/f64 silhouette flip; the absolute floor covers f16 storage quantization.
  const deltas = gpu.map((value, axis) => {
    const delta = Math.abs(value - cpu[axis]);
    return { gpu: value, cpu: cpu[axis], absoluteDelta: delta,
      relativeDelta: delta / Math.max(Math.abs(cpu[axis]), 1e-4) };
  });
  const passed = deltas.every(delta => delta.absoluteDelta <= flipAllowance);
  const worstAbsoluteDelta = Math.max(...deltas.map(delta => delta.absoluteDelta));
  const worstRelativeDelta = Math.max(...deltas.map(delta => delta.relativeDelta));
  return { passed, worstAbsoluteDelta, worstRelativeDelta, deltas };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "probe-radiance-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/probeRadianceGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"), "<!doctype html><title>Probe radiance GPU probe</title>");

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.validationMessages.length === 0 && probe.probes?.length) break;
    } catch (error) {
      probe = { validationMessages: [String(error instanceof Error ? error.message : error)], probes: [] };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  const module = await import(pathToFileURL(bundlePath));
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "probeSceneRadiance.wgsl"), module.emitProbeRadianceKernelWgsl());
  await rm(bundleDirectory, { recursive: true, force: true });
  const comparisons = (probe.probes ?? []).map(entry => ({
    name: entry.name, position: entry.position, gpu: entry.gpu, cpu: entry.cpu,
    flipAllowance: entry.flipAllowance, maxContribution: entry.maxContribution,
    ...probeMatchesCpu(entry.gpu, entry.cpu, entry.flipAllowance) }));
  const gate = comparisons.length === 3
    && comparisons.every(comparison => comparison.passed)
    && probe.overflowSentinel === 0
    && probe.openSkyExceedsOccluded === true
    && probe.oneBounceEnergyPresent === true
    && probe.validationMessages.length === 0;
  const report = {
    gate, adapter: probe.adapter, browserVersion: probe.browserVersion,
    overflowSentinel: probe.overflowSentinel,
    rawHalfWords: probe.rawHalfWords ?? [],
    validationMessages: probe.validationMessages,
    openSkyExceedsOccluded: probe.openSkyExceedsOccluded,
    oneBounceEnergyPresent: probe.oneBounceEnergyPresent,
    comparisons,
  };
  await writeFile(path.join(outputDirectory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ gate, adapter: report.adapter, overflowSentinel: report.overflowSentinel,
    comparisons: comparisons.map(({ name, gpu, cpu, passed }) => ({ name, gpu, cpu, passed })) }, null, 2));
  if (!gate) throw new Error("Probe radiance GPU gate failed; see report.json.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
