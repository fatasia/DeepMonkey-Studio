// A2 WGSL SDF 碰撞 profile:真机 WebGPU 数值探针 runner(骨架同款 clothParallelGpuTest.mjs)。
// esbuild 打包 sdfCollisionGpuProbe.ts → 本地 http 服务(probe.html/probe.bundle.mjs/fixture.json)
// → playwright + headless Chrome(--enable-unsafe-webgpu)执行 → 证据落
// test-output/a2-next-20261002/sdf-collision-gpu-r1/。
// 退出码:真机不可用(WebGPU 缺失)记 skip(退出 2);合同违约(容差/重放/fail-closed 破)退出 1。
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
const fixturePath = path.join(packageRoot, "../deep-engine-native/src/physics_sdf_l_fixture.json");
const wgslPath = path.join(packageRoot, "wgsl/sdfCollisionQuery.wgsl");
const wgslSidecarPath = path.join(packageRoot, "wgsl/sdfCollisionQuery.wgsl.sha256");
const outputDirectory = process.env.SDF_COLLISION_GPU_OUTPUT_DIR
  ? path.resolve(process.env.SDF_COLLISION_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "a2-next-20261002", "sdf-collision-gpu-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.SDF_COLLISION_GPU_TEST_ATTEMPTS ?? 2);
const sha256File = async (file) => createHash("sha256").update(new Uint8Array(await readFile(file))).digest("hex");

async function startServer(directory, fixtureBytes) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method !== "GET" || !["probe.html", "probe.bundle.mjs", "fixture.json"].includes(name)) {
      response.writeHead(404).end(); return;
    }
    if (name === "fixture.json") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(fixtureBytes); return;
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
      try { return { ok: true, result: await module.runSdfCollisionGpuProbe() }; }
      catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error),
          stack: String(error instanceof Error ? error.stack ?? "" : "").slice(0, 2000) };
      }
    }, undefined, { timeout: 120000 });
    return { adapter, pageErrors, replay: result };
  } finally { await browser.close(); }
}

async function main() {
  const [fixtureBytes, fixtureSha256, wgslSha256, wgslSidecar] = await Promise.all([
    readFile(fixturePath), sha256File(fixturePath), sha256File(wgslPath), readFile(wgslSidecarPath, "utf8"),
  ]);
  // sidecar 格式 = "<sha256> <byteLen>"(与 checksum 测试同解析),只取首字段。
  const [wgslSidecarChecksum] = wgslSidecar.trim().split(/\s+/);
  const wgslSidecarMatch = wgslSha256 === wgslSidecarChecksum;
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "sdf-collision-gpu-"));
  await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/sdfCollisionGpuProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"] });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>SDF collision GPU probe</title></head><body></body></html>`);
  let probe = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory, fixtureBytes);
    try { probe = await runInBrowser(origin); if (!probe.pageErrors?.length && probe.replay?.ok) break; }
    catch (error) { probe = { error: String(error instanceof Error ? error.message : error) }; }
    finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  if (probe?.error || probe?.replay?.error?.includes("WebGPU adapter unavailable")) {
    console.log(`sdf collision GPU probe: real device unavailable (${probe?.error ?? probe?.replay?.error}). 真机留项如实记录。`);
    process.exitCode = 2; return;
  }
  const failed = !probe || probe.error || probe.pageErrors?.length || !probe.replay?.ok;
  if (failed) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "probe-failure.json"), JSON.stringify(probe, null, 1));
    console.log(`sdf collision GPU probe failed: ${JSON.stringify(probe)?.slice(0, 800)}`);
    process.exitCode = 1; return;
  }
  const { adapter, replay } = probe;
  const result = replay.result;
  const distanceTolerance = 1e-4, gradientTolerance = 1e-4;
  const fresh = result.fresh;
  const evidence = {
    schema: "sdf-collision-gpu-probe-evidence-v1",
    createdAt: new Date().toISOString(),
    lane: "a2-next-sdf-collision-gpu-real-device",
    method: "F6 凹 L 夹具场(与 native truth 同字节源)× 同 seed LCG 4096 点;A2 查询核真机 dispatch vs CPU f32 镜像容差;一轮两 fresh 重放;域外 fail-closed NaN 位型",
    pins: { fixtureSha256, wgslSha256, wgslSidecarMatch },
    adapter, probe: result,
    verdict: {
      wgslSidecarMatch,
      statusesAllInDomain: fresh.every((row) => row.statusNonzeroCount === 0),
      distanceWithinTolerance: fresh.every((row) => row.maxDistanceErrorVsCpu <= distanceTolerance),
      gradientWithinTolerance: fresh.every((row) => row.maxGradientErrorVsCpu <= gradientTolerance),
      replayBitwise: result.replayBitwise === true,
      failClosedReachable: result.failClosed.statusOne && result.failClosed.nanBitPattern
        && result.failClosed.zeroGradient,
      gpuVsCpuBitwise: fresh.every((row) => row.gpuVsCpuBitwise),
    },
  };
  await mkdir(outputDirectory, { recursive: true });
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(adapter)}`);
  for (const [index, row] of fresh.entries()) {
    console.log(`fresh ${index + 1}: statusNonzero=${row.statusNonzeroCount} ` +
      `maxDistErr=${row.maxDistanceErrorVsCpu.toExponential(3)} maxGradErr=${row.maxGradientErrorVsCpu.toExponential(3)} ` +
      `penetrating=${row.penetratingCount} gpuBitwiseVsCpu=${row.gpuVsCpuBitwise}`);
  }
  console.log(`replayBitwise=${result.replayBitwise} failClosed=${JSON.stringify(result.failClosed)} ` +
    `memoryTotalBytes=${result.memoryBytes}`);
  console.log(`evidence: ${evidencePath} (sha256=${await sha256File(evidencePath)})`);
  const pass = evidence.verdict.wgslSidecarMatch && evidence.verdict.statusesAllInDomain
    && evidence.verdict.distanceWithinTolerance && evidence.verdict.gradientWithinTolerance
    && evidence.verdict.replayBitwise && evidence.verdict.failClosedReachable;
  if (!pass) process.exitCode = 1;
}

await main();
