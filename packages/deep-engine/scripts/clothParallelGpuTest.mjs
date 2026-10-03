// T18 A3 并行布料:真机 WebGPU 重放 runner(骨架同款 clusterLightCullingGpuTest.mjs)。
// esbuild 打包 clothParallelGpuProbe.ts → 本地 http 服务 → playwright + headless
// Chrome(--enable-unsafe-webgpu)执行 → 证据落 test-output/cloth-parallel-gpu-20260929-r1/。
// 退出码:真机不可用(WebGPU 缺失)记 skip(退出 2);合同违约(黄金容差/重放逐位破)退出 1。
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.CLOTH_PARALLEL_GPU_OUTPUT_DIR
  ? path.resolve(process.env.CLOTH_PARALLEL_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "cloth-parallel-gpu-20260929-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.CLOTH_PARALLEL_GPU_TEST_ATTEMPTS ?? 2);
const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

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
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message)));
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const result = await page.evaluate(async () => {
      const module = await import("./probe.bundle.mjs");
      try { return { ok: true, result: await module.runClothParallelGpuReplay(), production: await module.runClothParallelGpuProductionReplay(), softbody: await module.runSoftBodyParallelGpuCheck() }; }
      catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error),
          stack: String(error instanceof Error ? error.stack ?? "" : "").slice(0, 2000) };
      }
    }, undefined, { timeout: 420000 });
    return { adapter, pageErrors, replay: result };
  } finally { await browser.close(); }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "cloth-parallel-gpu-"));
  await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/clothParallelGpuProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"] });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Cloth parallel GPU probe</title></head><body></body></html>`);
  let probe = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try { probe = await runInBrowser(origin); if (!probe.pageErrors?.length && probe.replay?.ok) break; }
    catch (error) { probe = { error: String(error instanceof Error ? error.message : error) }; }
    finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  if (probe?.error || probe?.replay?.error?.includes("WebGPU adapter unavailable")) {
    console.log(`cloth parallel GPU probe: real device unavailable (${probe?.error ?? probe?.replay?.error}). 真机留项如实记录。`);
    process.exitCode = 2; return;
  }
  const failed = !probe || probe.error || probe.pageErrors?.length || !probe.replay?.ok;
  if (failed) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "probe-failure.json"), JSON.stringify(probe, null, 1));
    console.log(`cloth parallel GPU probe failed: ${JSON.stringify(probe)?.slice(0, 800)}`);
    process.exitCode = 1; return;
  }
  const { adapter, replay } = probe;
  const evidence = {
    schema: "cloth-parallel-gpu-replay-evidence-v1",
    createdAt: new Date().toISOString(),
    lane: "t18-a3-cloth-parallel-gpu-real-device",
    method: "wgsl/clothSolver.wgsl 单源编译真实 pipeline;色序 dispatch 合同;逐 24 tick 读回对拍 CPU f32 模拟镜像与 f64 黄金",
    adapter, replay: replay.result, production: replay.production, softbody: replay.softbody,
    verdict: {
      productionKernelParallel: replay.production?.production?.kernel === "cloth-parallel" && !replay.production?.production?.fallbackSeen,
      productionGoldenWithinTolerance: replay.production?.production?.goldenWithinTolerance === true, // 风场景容差 0.1(probe 侧登记)
      sessionBitwiseEqualsPerCall: replay.production?.sessionProfile?.bitwiseEqualsPerCall === true,
      sessionGoldenWithinTolerance: replay.production?.sessionProfile?.goldenWithinTolerance === true,
      sessionStretchWithinBand: replay.production?.sessionProfile?.stretchWithinBand === true,
      softbodyReplayBitwise: replay.softbody?.replayBitwise === true,
      softbodyMirrorTolerance: (replay.softbody?.per24 ?? []).every(row => row.maxErrVsMirror <= 0.05),
      simulationParityBitwise: replay.result.simulationParityBitwise,
      replayBitwise: replay.result.replayBitwise,
      goldenWithinTolerance: replay.result.golden.withinTolerance,
      stretchWithinBand: replay.result.stretch.gpuMaxRatio <= replay.result.stretch.band,
    },
  };
  await mkdir(outputDirectory, { recursive: true });
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(adapter)}`);
  for (const row of replay.result.per24) {
    console.log(`tick ${row.tick}: cpu=${row.cpuFingerprint} gpu=${row.gpuFingerprint} ` +
      `bitwise=${row.bitwiseMatch} maxFloatDrift=${row.gpuMaxPosErrVsCpu.toExponential(3)}`);
  }
  console.log(`replayBitwise=${replay.result.replayBitwise} kinetic.bitwise=${replay.result.kinetic.bitwiseMatch} ` +
    `goldenMaxErr=${replay.result.golden.maxPositionError.toExponential(3)} withinTolerance=${replay.result.golden.withinTolerance} ` +
    `gpuStretch=${replay.result.stretch.gpuMaxRatio.toExponential(3)}`);
  console.log(`evidence: ${evidencePath} (sha256=${sha256(await readFile(evidencePath))})`);
  const production = replay.production;
  const pass = replay.result.golden.withinTolerance
    && replay.result.stretch.gpuMaxRatio <= replay.result.stretch.band
    && replay.result.replayBitwise
    && production?.production?.kernel === "cloth-parallel"
    && !production?.production?.fallbackSeen
    && production?.production?.goldenWithinTolerance === true
    && production?.sessionProfile?.bitwiseEqualsPerCall === true
    && production?.sessionProfile?.goldenWithinTolerance === true
    && production?.sessionProfile?.stretchWithinBand === true
    && replay.softbody?.replayBitwise === true
    && (replay.softbody?.per24 ?? []).every(row => row.maxErrVsMirror <= 0.05);
  if (!pass) process.exitCode = 1;
}

await main();
