import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// T05 验收切片真机对拍 runner：生产实例剔除内核（GPU_FRUSTUM_CULL_WGSL + 生产
// HiZOcclusionCuller）在 headless Chrome 真 WebGPU 上读回，与 CPU 参考可见集
// （instanceVisibilityReference，同一 esbuild bundle 单一来源）对拍零错误漏剔。
// 场景：带洞遮挡墙 + 目标 + 背板（136 实例，遮挡门槛 128 之上）；Hi-Z 深度由
// Node 侧确定性软光栅参考上传（静态口径）。证据写 test-output/deep-core/T05/instance-culling-gpu-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.resolve(process.env.INSTANCE_CULLING_GPU_OUTPUT_DIR
  ?? path.join(repoRoot, "test-output", "deep-core", "T05", "instance-culling-gpu-r1"));
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.INSTANCE_CULLING_GPU_ATTEMPTS ?? 3);

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method !== "GET" || !["probe.html", "probe.bundle.mjs"].includes(name)) {
      response.writeHead(404).end(); return;
    }
    response.writeHead(200, { "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" })
      .end(await readFile(path.join(directory, name)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runInBrowser(origin, request) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    return await page.evaluate(async (probeRequests) => {
      const module = await import("./probe.bundle.mjs");
      const results = [];
      for (const probeRequest of probeRequests) {
        results.push(await module.runInstanceCullingGpuProbe(probeRequest));
      }
      return results;
    }, request);
  } finally { await browser.close(); }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "instance-culling-gpu-"));
  await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/instanceCullingGpuProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"] });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Instance culling GPU probe</title></head><body></body></html>`);
  const module = await import(pathToFileURL(path.join(bundleDirectory, "probe.bundle.mjs")).toString());
  const scenarios = [
    { name: "wall-hole-forward", reversedZ: false, eye: [0, 0, 30] },
    { name: "wall-hole-reversedz", reversedZ: true, eye: [0, 0, 30] },
  ];
  const topMipOnly = process.env.INSTANCE_CULLING_GPU_TOP_MIP_ONLY === "1";
  const requests = scenarios.map(({ name, reversedZ, eye }) => {
    const scene = module.buildCullingGpuScene(eye, reversedZ);
    if (topMipOnly) scene.depthMips = scene.depthMips.slice(0, 1);
    return { name: topMipOnly ? name + "-mip0only" : name, reversedZ, scene, request: {
      instancesBase64: scene.instancesBase64, boundsBase64: scene.boundsBase64,
      frustumBase64: scene.frustumBase64, viewProjectionBase64: scene.viewProjectionBase64 ?? null,
      cameraPosition: scene.cameraPosition, viewport: [320, 180],
      instanceCount: scene.instances.length, indexCount: scene.indexCount,
      depthMips: scene.depthMips, reversedZ } };
  });
  // viewProjection 需要单独打包（fixture 未导出 base64）——这里补上。
  const packF32 = (values) => Buffer.from(new Float32Array(values).buffer).toString("base64");
  for (const entry of requests) entry.request.viewProjectionBase64 = packF32([...entry.scene.viewProjection]);

  await mkdir(path.join(outputDirectory), { recursive: true });
  let probe = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin, requests.map(entry => entry.request));
      if (probe.every(result => result.errors.length === 0)) break;
    } catch (error) {
      probe = [{ error: String(error instanceof Error ? error.message : error) }];
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  if (!probe || !probe.every(result => result && result.errors && result.errors.length === 0)) {
    await mkdir(path.join(outputDirectory), { recursive: true });
    await writeFile(path.join(outputDirectory, "probe-failure.json"), JSON.stringify(probe, null, 1));
    console.log(`instance culling GPU probe failed: ${JSON.stringify(probe)?.slice(0, 300)}`);
    process.exitCode = 1;
    return;
  }

  const round4 = (value) => Math.round(value * 1e4) / 1e4;
  const cases = requests.map((entry, index) => {
    const result = probe[index];
    const indexBytes = Buffer.from(result.hizIndicesBase64, "base64");
    const indices = [...new Uint32Array(indexBytes.buffer, indexBytes.byteOffset,
      Math.min(result.hizVisibleCount, Math.floor(indexBytes.byteLength / 4)))];
    const kept = new Uint8Array(entry.scene.instances.length);
    for (const index of indices) kept[index] = 1;
    const wrongCulled = [], conservativeKept = [];
    let referenceCount = 0;
    for (let instance = 0; instance < entry.scene.instances.length; instance++) {
      if (entry.scene.referenceVisible[instance]) { referenceCount++; if (!kept[instance]) wrongCulled.push(instance); }
      else if (kept[instance]) conservativeKept.push(instance);
    }
    // 逐 mip 上传保真度：与 Node 期望金字塔比对（容差 1e-6），零容差失败即上传缺陷。
    const mipMismatches = [];
    result.uploadedMips.forEach((uploaded, level) => {
      const expected = entry.scene.depthMips[level];
      const expectedBytes = Buffer.from(expected.dataBase64, "base64");
      const expectedValues = [...new Float32Array(expectedBytes.buffer, expectedBytes.byteOffset,
        Math.floor(expectedBytes.byteLength / 4))];
      let mismatched = 0;
      uploaded.values.forEach((value, index) => {
        if (Math.abs(value - expectedValues[index]) > 1e-6) mismatched++;
      });
      if (mismatched) mipMismatches.push({ level, mismatched, of: uploaded.values.length,
        firstValues: uploaded.values.slice(0, 8).map(round4), expectedFirst: expectedValues.slice(0, 8).map(round4),
        rowStart: uploaded.values.slice(320, 326).map(round4), expectedRowStart: expectedValues.slice(320, 326).map(round4),
        firstRowHex: uploaded.firstRowHex });
    });
    return { name: entry.name, reversedZ: entry.reversedZ, instanceCount: entry.scene.instances.length,
      referenceVisible: referenceCount, frustumSurvivors: result.frustumSurvivors,
      hizVisibleCount: result.hizVisibleCount, wrongCulled, conservativeKeptCount: conservativeKept.length,
      conservativeKept, zeroWrongCull: wrongCulled.length === 0, mipMismatches, adapter: result.adapter };
  });
  const gate = cases.every(entry => entry.zeroWrongCull);
  const evidence = { schema: "instance-culling-gpu-evidence-v1", createdAt: new Date().toISOString(),
    lane: "t05-instance-culling-real-gpu", method: "生产 WGSL 视锥核 + 生产 HiZOcclusionCuller；参考深度由确定性软光栅上传（静态口径）",
    cases, verdict: { zeroWrongCull: gate,
      note: "wrongCulled（参考可见但 GPU 剔除）必须为空；conservativeKept 为保守保留计数。" } };
  await writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  for (const entry of cases) {
    console.log(`${entry.name}: refVisible=${entry.referenceVisible} frustumSurvivors=${entry.frustumSurvivors} ` +
      `hizVisible=${entry.hizVisibleCount} wrongCulled=${entry.wrongCulled.length} conservativeKept=${entry.conservativeKeptCount}`);
  }
  console.log(`zero-wrong-cull verdict: ${gate ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!gate) process.exitCode = 1;
}

await main();
