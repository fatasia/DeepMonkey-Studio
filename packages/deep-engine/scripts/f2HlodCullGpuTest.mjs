// F2/驻留感知 HLOD 冻结场景 GPU 对照 runner(scripts/f2HlodCullGpuProbe.ts + f2HlodCullPayload.ts;
// 骨架同 clusterLodGpuTest.mjs / clothParallelGpuTest.mjs:esbuild 双 bundle → 本地 http →
// playwright headless Chrome + --enable-unsafe-webgpu)。
//
// 三腿:①对象 ID 两态逐像素对照(全量实例 vs 生产 applyHlodPlanToInstances 折叠态);
// ②轮廓差异像素计数(如实记录);③时序 Hi-Z 帧内锚点(生产 HiZPyramid vs 生产 CPU 孪生逐位)。
// T26 削减率复核 = 计划层账目(hlodProxyDrawCost,与 batch-benchmark.json 同源)+ 真机零像素佐证。
// 纪律:帧时类测量本批禁测(并行 GPU 负载);失败/不可用如实留项,不美化。
// 证据:test-output/f2-hlod-cull-20261002/{evidence,evidence2}.json(fresh×2)。

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
const outputDirectory = process.env.F2_HLOD_GPU_OUTPUT_DIR
  ? path.resolve(process.env.F2_HLOD_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "f2-hlod-cull-20261002");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.F2_HLOD_GPU_TEST_ATTEMPTS ?? 3);
const FAR_LABEL = "远 4×";
const NEAR_LABEL = "近 0.25×";
// T26 复核带(与 hlodClusterStream.batchBench.test.ts 同带:远档 ≥200 且 ≤280)。
const FAR_PROXY_MIN = 200, FAR_PROXY_MAX = 280;

const sha256File = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

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

async function runInBrowser(origin, payload) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error?.message ?? error)));
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const result = await page.evaluate(async (probePayload) => {
      const module = await import("./probe.bundle.mjs");
      return module.runF2HlodCullGpuProbe(probePayload);
    }, payload);
    result.pageErrors = pageErrors;
    return result;
  } finally {
    await browser.close();
  }
}

function verdictOf(probe, payload) {
  const cameras = probe.cameras ?? [];
  const byLabel = new Map(cameras.map(camera => [camera.label, camera]));
  const far = byLabel.get(FAR_LABEL);
  const near = byLabel.get(NEAR_LABEL);
  const payloadFar = payload.cameras.find(camera => camera.label === FAR_LABEL);
  const checks = {
    deviceClean: (probe.deviceErrors ?? []).length === 0 && (probe.pageErrors ?? []).length === 0,
    noTrueMissAllCameras: cameras.length === payload.cameras.length
      && cameras.every(camera => camera.missTrue === 0),
    hiddenZeroPixelAllCameras: cameras.every(camera => camera.hiddenViolationPixels === 0),
    nearUncollapsedIdentity: near !== undefined
      && near.memberAgreePixels + near.proxyReplacedPixels + near.memberSwapPixels > 0,
    farFullyCollapsed: far !== undefined && far.hiddenSet === payload.ids.length,
    farProxyBand: far !== undefined && far.activeProxies >= FAR_PROXY_MIN && far.activeProxies <= FAR_PROXY_MAX,
    // T26 计划层账目在载荷(payloadFar.t26,与 batch-benchmark.json 同源);GPU 侧作零像素佐证。
    farBatchedDrawIsOne: payloadFar?.t26?.batchedDraws === 1,
    // 生产非流送合同:折叠态实例表 = 全部成员(隐藏缩放)+ 全部代理(非活动缩放)。
    instanceCountInvariant: far !== undefined
      && far.instancesB === payload.ids.length + payload.proxyList.length,
    hiZBitwise: probe.hiZ?.levels?.length > 0 && probe.hiZ.levels.every(level => level.bitwise),
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "f2-hlod-cull-gpu-"));
  // Node 侧载荷 bundle 必须落在包内两层深处(tmpbuild/f2-hlod/):车间夹具按
  // import.meta.url 相对定位 lab/assets(dir/../../lab/assets = packages/deep-engine/lab/assets)。
  const payloadDirectory = path.join(packageRoot, "tmpbuild", "f2-hlod");
  await mkdir(payloadDirectory, { recursive: true });
  const payloadBundlePath = path.join(payloadDirectory, "payload.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/f2HlodCullPayload.ts"], bundle: true,
    format: "esm", platform: "node", target: "node20", outfile: payloadBundlePath, logLevel: "silent" });
  const payloadModule = await import(pathToFileURL(payloadBundlePath));
  const payload = await payloadModule.buildF2Payload();

  // 浏览器 bundle(生产 applyHlodPlanToInstances / packTransform / HiZPyramid / CPU 孪生)。
  await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/f2HlodCullGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"), logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>F2 HLOD cull GPU probe</title></head><body></body></html>`);

  let probe = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try { probe = await runInBrowser(origin, payload); if (!probe.fatal && !probe.pageErrors?.length) break; }
    catch (error) { probe = { fatal: String(error instanceof Error ? error.message : error) }; }
    finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  await rm(path.dirname(payloadBundlePath), { recursive: true, force: true }).catch(() => {});
  if (probe?.fatal?.includes("WebGPU adapter unavailable")) {
    console.log(`F2 HLOD cull GPU probe: real device unavailable (${probe.fatal}). 真机留项如实记录。`);
    process.exitCode = 2; return;
  }
  if (!probe || probe.fatal || probe.pageErrors?.length) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "probe-failure.json"), JSON.stringify(probe, null, 1));
    console.log(`F2 HLOD cull GPU probe failed: ${JSON.stringify(probe)?.slice(0, 1200)}`);
    process.exitCode = 1; return;
  }

  const verdict = verdictOf(probe, payload);
  const evidence = {
    schema: "f2-hlod-cull-gpu-evidence-v1",
    createdAt: new Date().toISOString(),
    lane: "f2-hlod-cull-frozen-scene-gpu",
    payload: { tier: payload.ids.length, sourceTriangles: payload.sourceTriangles,
      proxyNodeCount: payload.proxyList.length, cameras: payload.cameras.map(camera => ({
        label: camera.label, hiddenInstances: camera.hiddenInstances, activeProxies: camera.activeProxies,
        collapsedNodeCount: camera.collapsedNodeCount, t26: camera.t26 })),
      payloadSha256: sha256File(Buffer.from(JSON.stringify(payload))) },
    adapter: probe.adapter, browserVersion: probe.browserVersion,
    deviceErrors: probe.deviceErrors, pageErrors: probe.pageErrors ?? [],
    cameras: probe.cameras, hiZ: probe.hiZ, draws: probe.draws,
    verdict,
    gates: {
      missTrue: "逐相机 =0(代理保守超集;1px 膨胀后仍空才算真缺)",
      hiddenViolationPixels: "逐相机 =0(隐藏成员 1e-6 缩放零像素)",
      farProxyBand: `[${FAR_PROXY_MIN},${FAR_PROXY_MAX}](与 batchBench 同带)`,
      hiZBitwise: "GPU HiZPyramid 逐 mip 与生产 CPU 孪生逐位相等(min/max 精确归约,无容差)",
      honestNote: "missRaw/overhang/proxyReplaced/overhang 等差异像素为显式计量项,不设门限、不美化",
    },
  };
  const evidencePath = process.env.F2_EVIDENCE_NAME
    ? path.join(outputDirectory, process.env.F2_EVIDENCE_NAME)
    : path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  for (const camera of probe.cameras) {
    console.log(`${camera.label}: A=${camera.instancesA} B=${camera.instancesB}(退化 ${camera.degenerateB}) `
      + `hidden=${camera.hiddenSet} proxies=${camera.activeProxies} aCov=${camera.aCovered} bCov=${camera.bCovered} `
      + `missRaw=${camera.missRaw} missTrue=${camera.missTrue} overhang=${camera.overhang} `
      + `agree=${camera.agreePixels}(member ${camera.memberAgreePixels}) proxyReplaced=${camera.proxyReplacedPixels} `
      + `hiddenViolation=${camera.hiddenViolationPixels}`);
  }
  console.log(`t26 远档: hidden=${payload.cameras.find(c => c.label === FAR_LABEL)?.hiddenInstances} `
    + `proxies=${payload.cameras.find(c => c.label === FAR_LABEL)?.activeProxies} `
    + `batchedDraws=${payload.cameras.find(c => c.label === FAR_LABEL)?.t26.batchedDraws} `
    + `drawReduction=${payload.cameras.find(c => c.label === FAR_LABEL)?.t26.drawReduction.toFixed(6)}`);
  console.log(`hiZ: mips=${probe.hiZ.levels.length} bitwise=${probe.hiZ.levels.every(l => l.bitwise)} `
    + `maxAbsDiff=${Math.max(...probe.hiZ.levels.map(l => l.maxAbsDiff))}`);
  console.log(`verdict: ${verdict.pass ? "PASS" : "FAIL"} ${JSON.stringify(verdict.checks)}`);
  console.log(`evidence: ${evidencePath} (sha256=${sha256File(await readFile(evidencePath))})`);
  if (!verdict.pass) process.exitCode = 1;
}

await main();
