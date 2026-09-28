import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// G1-S1 真机 GPU 验收 runner：静态 CAD 夹具全链在真实 WebGPU 上驱动**产品槽位类**
// （ClusterLodRenderSlot，非旁路）。模式沿用 clusterLodGpuTest.mjs（headless Chrome + WebGPU，
// Node/浏览器共用同一 esbuild bundle 单一来源，防口径分叉）。
// 仲裁（Node 侧）：
//  1. GPU 选层槽位与 CPU 参考（selectClusterLod）逐位相等（u32），faults/fallback 为零；
//  2. 前沿 multiset 相等：CPU deriveClusterLodFrontier ↔ 槽位 lastSelectionEvidence 节点 id；
//  3. 剪影 ≤1px：CPU 光栅 L0 参考（rasterizeSilhouetteMask，同一 viewProjection）vs
//     GPU 像素读回掩码，measureSilhouetteDeviation 双向 Chebyshev ≤1；
//  4. 空白对照 = 0；uncaptured 错误/会话诊断为零；
//  5. draw 对照（如实报）：前沿 draws/triangles vs 逐实例 L0 全量（10 实例口径，页/几何共享）。
// 证据写入 test-output/cluster-lod-cad-gpu-20260929-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.CLUSTER_LOD_CAD_GPU_OUTPUT_DIR
  ? path.resolve(process.env.CLUSTER_LOD_CAD_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "cluster-lod-cad-gpu-20260929-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.CLUSTER_LOD_CAD_GPU_TEST_ATTEMPTS ?? 3);
const INSTANCES = 10;

const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const base64ToBytes = (value) => Uint8Array.from(Buffer.from(value, "base64"));
const unpackBits = (bytes, total) => {
  const mask = new Uint8Array(total);
  for (let index = 0; index < total; index++) mask[index] = (bytes[index >> 3] & (1 << (index & 7))) !== 0 ? 1 : 0;
  return mask;
};

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
      return module.runClusterLodCadProbe();
    });
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "cluster-lod-cad-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/clusterLodCadGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  const module = await import(pathToFileURL(bundlePath));
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Cluster LOD CAD GPU probe</title></head><body></body></html>`);

  const caseSpec = module.buildClusterLodCadCase();
  const dag = caseSpec.stage.dag;
  const side = module.CLUSTER_LOD_CAD_VIEWPORT;
  const l0Clusters = dag.nodes.filter(node => node.level === 0 && node.triangleCount > 0).length;
  const l0Triangles = dag.leafTriangleTotal;

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { errors: [String(error instanceof Error ? error.message : error)], cases: [], adapter: {},
        clearOnlyCoveredPixels: -1, staticFrameCpuMs: null, selectionStepCpuMs: null,
        sessionDiagnostics: [] };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  await mkdir(path.join(outputDirectory, "outputs"), { recursive: true });
  const cameraResults = [];
  let gate = probe.errors.length === 0 && probe.clearOnlyCoveredPixels === 0
    && probe.sessionDiagnostics.length === 0 && Array.isArray(probe.cases)
    && probe.cases.length === caseSpec.cameras.length;
  for (const [cameraIndex, cameraCase] of caseSpec.cameras.entries()) {
    const evidence = probe.cases[cameraIndex] ?? null;
    const cpu = module.selectClusterLod(dag, cameraCase.camera);
    const gpuWords = evidence ? [...new Uint32Array(base64ToBytes(evidence.selectionBase64).buffer.slice(0))] : [];
    const slotMismatches = gpuWords.filter((value, index) => value !== cpu.selection[index]).length;
    const slotAgreement = gpuWords.length === cpu.selection.length && slotMismatches === 0;
    const cpuFrontier = module.deriveClusterLodFrontier(dag, cpu.selection)
      .map(index => dag.nodes[index].id).sort();
    const frontierMultisetAgreement = evidence !== null
      && JSON.stringify([...evidence.frontierNodeIds].sort()) === JSON.stringify(cpuFrontier);
    // 剪影仲裁：CPU 光栅 L0 参考（与 GPU 同一 VP/分辨率）vs GPU 像素读回掩码。
    const projection = { viewProjection: cameraCase.viewProjection, viewport: [side, side] };
    const reference = module.rasterizeSilhouetteMask(caseSpec.stage.levelGeometry[0].vertices,
      caseSpec.stage.levelGeometry[0].indices, projection);
    const gpuMask = evidence ? unpackBits(base64ToBytes(evidence.maskBitsBase64), side * side) : new Uint8Array(0);
    const deviation = evidence
      ? module.measureSilhouetteDeviation(reference.mask, gpuMask, side, side)
      : { maxDeviationPx: Infinity, selectedStrayPixels: -1, referenceStrayPixels: -1 };
    const silhouetteOk = deviation.maxDeviationPx <= 1;
    const perInstanceDraws = INSTANCES * l0Clusters;
    const microPolygonDraws = evidence?.metrics.draws ?? 0;
    const drawReduction = microPolygonDraws > 0 ? perInstanceDraws / microPolygonDraws : 0;
    const passed = evidence !== null && slotAgreement && frontierMultisetAgreement && silhouetteOk
      && evidence.metrics.fallbackReason === undefined && evidence.metrics.draws > 0
      && evidence.coveredPixels > 0 && reference.mask.reduce((sum, value) => sum + value, 0) > 0
      && drawReduction > 5;
    gate &&= passed;
    cameraResults.push({ camera: cameraCase.label, passed, slotMismatches, slotAgreement,
      frontierMultisetAgreement, frontierNodeIds: evidence?.frontierNodeIds ?? null,
      cpuFrontierDraws: cpuFrontier.length,
      draws: microPolygonDraws, triangles: evidence?.metrics.triangles ?? 0,
      frontierMaxLevel: evidence?.metrics.frontierMaxLevel ?? -1,
      coveredPixels: evidence?.coveredPixels ?? 0, totalPixels: evidence?.totalPixels ?? 0,
      referenceCovered: reference.mask.reduce((sum, value) => sum + value, 0),
      maxDeviationPx: deviation.maxDeviationPx, selectedStrayPixels: deviation.selectedStrayPixels,
      referenceStrayPixels: deviation.referenceStrayPixels, silhouetteOk,
      l0Clusters, perInstanceDraws, microPolygonDraws, drawReduction: Number(drawReduction.toFixed(3)),
      staticFrameCpuMs: probe.staticFrameCpuMs, selectionStepCpuMs: probe.selectionStepCpuMs,
      gpuSelectionSha256: evidence ? sha256(base64ToBytes(evidence.selectionBase64)) : null,
      cpuSelectionSha256: sha256(Uint32Array.from(cpu.selection)),
      gpuMaskSha256: evidence ? sha256(base64ToBytes(evidence.maskBitsBase64)) : null });
  }

  const evidence = {
    schema: "cluster-lod-cad-gpu-evidence-v1",
    lane: "g1s1-cluster-lod-render-slot-real-gpu",
    createdAt: new Date().toISOString(),
    environment: { chromeVersion: probe.browserVersion, userAgent: probe.userAgent, adapter: probe.adapter },
    chain: "CAD fixture -> bakeClusterLodDag -> ClusterLodRenderSlot(stage/updateCamera/encodeFrame/draw/ingest) "
      + "-> planClusterLodIndirect -> ClusterLodIndirectExecutor -> executeBundles(drawIndexedIndirect) -> pixel readback",
    clearOnlyCoveredPixels: probe.clearOnlyCoveredPixels,
    errors: probe.errors,
    sessionDiagnostics: probe.sessionDiagnostics,
    staticFrameCpuMs: probe.staticFrameCpuMs,
    selectionStepCpuMs: probe.selectionStepCpuMs,
    gate,
    cameras: cameraResults,
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);

  for (const camera of cameraResults) {
    const level = camera.passed ? "PASS" : "FAIL";
    console.log(`${level} ${camera.camera}: slotAgreement=${camera.slotAgreement} frontierMultiset=${camera.frontierMultisetAgreement}`
      + ` silhouette<=1px=${camera.silhouetteOk} (maxDev=${camera.maxDeviationPx}) draws=${camera.draws}/${camera.l0Clusters}L0`
      + ` triangles=${camera.triangles}/${l0Triangles}`
      + ` drawReduction=${camera.drawReduction}x@${INSTANCES}inst`);
  }
  console.log(`cluster LOD CAD GPU gate: ${gate ? "PASS" : "FAIL"} (clearOnly=${probe.clearOnlyCoveredPixels}`
    + ` staticFrameCpuMs=${probe.staticFrameCpuMs?.toFixed(3)} selectionStepCpuMs=${probe.selectionStepCpuMs?.toFixed(3)})`
    + ` evidence=${path.join(outputDirectory, "evidence.json")}`);
  if (!gate) process.exitCode = 1;
}

await main();
