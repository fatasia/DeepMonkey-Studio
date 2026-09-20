import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// Cluster LOD 选层 kernel 真机对拍 runner（波次5；模式沿用 rayTraceGpuTest.mjs）。
// headless Chrome + WebGPU 走完整 API 路径：bake DAG → packClusterLodNodes/Camera →
// dispatch select_cluster_lod → 读回 selection+faults；与 CPU 参考（selectClusterLod，
// 同 esbuild bundle 单一来源，防口径分叉）逐槽位精确对拍（u32 相等），并断言：
// 近距全选细层 / 远距粗层 / 混合前沿 / 阈值扫描单调 / 阈值边界余量 ≥5%。
// GPU 读回槽位喂 planClusterLodIndirect 派生绘制清单，与期望前沿对拍 —— 间接命令合同同机受检。
// 证据写入 test-output/cluster-lod-gpu-20260920-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "cluster-lod-gpu-20260920-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.CLUSTER_LOD_GPU_TEST_ATTEMPTS ?? 3);
const MIN_MARGIN = 0.05;

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
      return module.runClusterLodGpuProbe(caseRequests);
    }, requests);
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "cluster-lod-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/clusterLodGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  const module = await import(pathToFileURL(bundlePath));
  await writeFile(path.join(bundleDirectory, "probe.html"), `<!doctype html><title>Cluster LOD GPU probe</title>`);

  const specs = module.buildClusterLodCases();
  const requests = module.buildClusterLodRequests(specs);
  // CPU 参考（Node 侧，同一 bundle 单一来源）：逐机位预算槽位/前沿/阈值边界余量。
  const references = new Map(specs.map((spec) => [spec.name, {
    spec,
    cpu: spec.cameras.map(({ camera }) => module.selectClusterLod(spec.dag, camera)),
    minMargins: spec.cameras.map(({ camera }) => Math.min(...spec.dag.nodes
      .filter(node => node.level > 0)
      .map(node => Math.abs(module.clusterScreenError(node, camera) - camera.pixelThreshold) / camera.pixelThreshold))),
  }]));

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin, requests);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { errors: [String(error instanceof Error ? error.message : error)], cases: {},
        adapter: {}, features: [], validationMessages: [] };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  await mkdir(path.join(outputDirectory, "outputs"), { recursive: true });
  const wgsl = module.emitClusterLodSelectionWgsl();
  await writeFile(path.join(outputDirectory, "clusterLodSelection.wgsl"), wgsl);

  const SENTINEL = 0xffff_ffff;
  const caseResults = [];
  let gate = Boolean(probe.cases) && Object.keys(probe.cases).length === specs.length && probe.errors.length === 0;
  for (const spec of specs) {
    const reference = references.get(spec.name);
    const backends = probe.cases?.[spec.name];
    gate &&= Array.isArray(backends) && backends.length === spec.cameras.length;
    let previousWords = null, previousMaxLevel = -1;
    const cameraResults = (backends ?? []).map((backend, cameraIndex) => {
      const { label, camera } = spec.cameras[cameraIndex];
      const cpu = reference.cpu[cameraIndex];
      const gpuWords = backend
        ? [...new Uint32Array(base64ToBytes(backend.selectionBase64).buffer.slice(0))]
        : [];
      const slotMismatches = gpuWords.filter((value, index) => value !== cpu.selection[index]).length;
      const slotAgreement = gpuWords.length === cpu.selection.length && slotMismatches === 0;
      let plan = null, drawsAgreement = false, maxFrontierLevel = -1;
      try {
        plan = module.planClusterLodIndirect(spec.dag, Uint32Array.from(gpuWords), spec.levels);
        const draws = plan.draws.map(draw => [draw.nodeId, draw.level]);
        const expectation = spec.expectations[cameraIndex];
        drawsAgreement = expectation.expectedDraws === undefined
          || JSON.stringify(draws) === JSON.stringify(expectation.expectedDraws);
        maxFrontierLevel = Math.max(...plan.draws.map(draw => draw.level));
      } catch { drawsAgreement = false; }
      const expectation = spec.expectations[cameraIndex];
      const levelAgreement = expectation.expectedMaxFrontierLevel === undefined
        || maxFrontierLevel === expectation.expectedMaxFrontierLevel;
      const allSlotsSelected = expectation.expectedAllSlotsSelected === undefined
        || (gpuWords.length > 0 && gpuWords.every(value => value !== SENTINEL));
      // 阈值单调（sweep 案例）：GPU 槽位逐节点单调 + 前沿最大层级不降。
      const monotoneOk = !spec.monotoneSweep || previousWords === null
        || (gpuWords.every((value, index) => previousWords[index] === SENTINEL || value !== SENTINEL)
          && maxFrontierLevel >= previousMaxLevel);
      previousWords = gpuWords; previousMaxLevel = maxFrontierLevel;
      const minMargin = reference.minMargins[cameraIndex];
      const marginOk = minMargin >= MIN_MARGIN;
      const passed = backend !== undefined && backend.faults === 0 && slotAgreement && drawsAgreement
        && levelAgreement && allSlotsSelected && monotoneOk && marginOk
        && probe.validationMessages.length === 0;
      gate &&= passed;
      return { camera: label, threshold: Number(camera.pixelThreshold.toFixed(3)), webgpuRan: Boolean(backend),
        faults: backend?.faults ?? null, slotMismatches, slotAgreement, drawsAgreement,
        gpuFrontierDraws: plan ? plan.draws.map(draw => [draw.nodeId, draw.level]) : null,
        expectedDraws: expectation.expectedDraws ?? null, maxFrontierLevel, levelAgreement,
        allSlotsSelected, monotoneOk, minMargin: Number(minMargin.toFixed(4)), marginOk,
        gpuSelectionSha256: backend ? sha256(base64ToBytes(backend.selectionBase64)) : null,
        cpuSelectionSha256: sha256(Uint32Array.from(cpu.selection)),
        firstRawSlots: backend?.firstRawSlots ?? [] };
    });
    caseResults.push({ name: spec.name, note: spec.note, nodeCount: spec.dag.nodes.length,
      dispatchWorkgroups: Math.ceil(spec.dag.nodes.length / module.CLUSTER_LOD_SELECTION_WORKGROUP_SIZE),
      monotoneSweep: Boolean(spec.monotoneSweep), cameras: cameraResults });
  }

  const webgpuAvailable = Object.keys(probe.cases ?? {}).length > 0;
  const evidence = {
    schema: "cluster-lod-gpu-evidence-v1",
    lane: "wave5-cluster-lod-selection-real-gpu", createdAt: new Date().toISOString(),
    kernel: { name: "select_cluster_lod", entryPoint: module.CLUSTER_LOD_SELECTION_ENTRY_POINT,
      workgroupSizeX: module.CLUSTER_LOD_SELECTION_WORKGROUP_SIZE,
      bindingOrder: ["clusterNodes:read-only-storage", "selection:storage", "selectionFaults:storage", "params:uniform"] },
    artifacts: { wgsl: { sha256: sha256(await readFile(path.join(outputDirectory, "clusterLodSelection.wgsl"))),
      consumers: ["webgpu-dawn", "native-wgpu-pending"] } },
    environment: { chromeVersion: probe.browserVersion ?? null, userAgent: probe.userAgent ?? null,
      adapter: probe.adapter ?? null, features: probe.features ?? [],
      kernelValidationMessages: probe.validationMessages ?? [], probeErrors: probe.errors },
    cases: caseResults,
    verdict: {
      webgpuAvailable, cpuGpuAgreement: gate,
      notes: [
        "CPU 参考与浏览器腿共用同一 esbuild bundle（bake/打包/CPU 选层/前沿与 indirect 计划单一来源，防口径分叉）。",
        "对拍合同：selection 槽位逐节点 u32 精确相等（阈值边界两侧同用 ≤）；f32 与 JS f64 舍入差由案例余量门槛吸收（每个中间层节点屏幕误差距阈值 ≥5%），余量随证据记录。",
        "断言族：近距全选细层 / 远距粗层 / 混合前沿（l1+4×L0 同帧）/ 阈值扫描逐节点单调且最大前沿层级 0→1→2 / faults 哨兵恒 0。",
        "GPU 读回槽位喂 planClusterLodIndirect（间接命令计划）派生绘制清单后与期望前沿对拍 —— 间接合同在真机输出上受检。",
        "nodeCount=10 < workgroup 64：每次 dispatch 有越界 lane，顺带受检 kernel 越界守卫。",
        "WGSL 编译诊断（getCompilationInfo 非 info 消息）非空即整批拒绝。",
      ],
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  const summary = caseResults.map((entry) => entry.cameras.map((camera) =>
    `${entry.name}/${camera.camera}: slots=${camera.slotAgreement ? "match" : `MISMATCH(${camera.slotMismatches})`} ` +
    `draws=${camera.drawsAgreement ? "match" : "MISMATCH"} maxLevel=${camera.maxFrontierLevel} ` +
    `faults=${camera.faults} margin=${camera.minMargin}`).join("\n"));
  console.log(summary.join("\n"));
  console.log(`WebGPU available: ${webgpuAvailable}; CPU/GPU agreement verdict: ${gate ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!gate) process.exitCode = 1;
}

await main();
