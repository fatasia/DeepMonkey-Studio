// F6/T18 软体并行核障碍刀:真机 WebGPU 重放 runner(骨架同款 clothParallelGpuTest.mjs)。
// esbuild 打包 softBodyObstacleGpuProbe.ts → 本地 http 服务 → playwright + headless
// Chrome(--enable-unsafe-webgpu)执行 → 证据落 test-output/softbody-obstacle-gpu-20261002/。
// 退出码:真机不可用(WebGPU 缺失)记 skip(退出 2);合同违约退出 1。
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
const outputDirectory = process.env.SOFTBODY_OBSTACLE_GPU_OUTPUT_DIR
  ? path.resolve(process.env.SOFTBODY_OBSTACLE_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "softbody-obstacle-gpu-20261002");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.SOFTBODY_OBSTACLE_GPU_ATTEMPTS ?? 2);
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
      try {
        return {
          ok: true,
          variantMatrix: await module.runObstaclePassVariantMatrix(),
          projection: await module.runSoftBodyObstacleProjectionCheck(),
          replay: await module.runSoftBodyObstacleGpuReplay(),
          uncapturedGpuErrors: [...module.gpuUncapturedErrors],
        };
      } catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error),
          stack: String(error instanceof Error ? error.stack ?? "" : "").slice(0, 2000),
          uncapturedGpuErrors: [...module.gpuUncapturedErrors] };
      }
    }, undefined, { timeout: 420000 });
    return { adapter, pageErrors, result };
  } finally { await browser.close(); }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "softbody-obstacle-gpu-"));
  const bundle = await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/softBodyObstacleGpuProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"], metafile: true });
  const sources = await Promise.all(Object.keys(bundle.metafile.inputs).map(async (name) => ({
    path: path.resolve(packageRoot, name), sha256: sha256(await readFile(path.resolve(packageRoot, name))),
  })));
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Softbody obstacle GPU probe</title></head><body></body></html>`);
  let probe = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try { probe = await runInBrowser(origin); if (!probe.pageErrors?.length && probe.result?.ok) break; }
    catch (error) { probe = { error: String(error instanceof Error ? error.message : error) }; }
    finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  if (probe?.error || probe?.result?.error?.includes("WebGPU adapter unavailable")) {
    console.log(`softbody obstacle GPU probe: real device unavailable (${probe?.error ?? probe?.result?.error}). 真机留项如实记录。`);
    process.exitCode = 2; return;
  }
  const failed = !probe || probe.error || probe.pageErrors?.length || !probe.result?.ok;
  if (failed) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "probe-failure.json"), JSON.stringify(probe, null, 1));
    console.log(`softbody obstacle GPU probe failed: ${JSON.stringify(probe)?.slice(0, 1200)}`);
    process.exitCode = 1; return;
  }
  const { adapter, result } = probe;
  const projection = result.projection;
  const replay = result.replay;
  const variantMatrix = result.variantMatrix ?? null;
  if (variantMatrix && !variantMatrix.executedAny) {
    console.log(`obstacle pass variant matrix: NO variant executed ${JSON.stringify(variantMatrix)}`);
  }
  const sourceIdentityStable = (await Promise.all(sources.map(async (source) =>
    source.sha256 === sha256(await readFile(source.path))))).every(Boolean);
  const evidence = {
    schema: "softbody-obstacle-gpu-evidence-v1",
    sources, sourceIdentityStable,
    createdAt: new Date().toISOString(),
    lane: "f6-t18-softbody-parallel-obstacle-gpu-real-device",
    method: "softBodyParallelSolverWgsl projectObstaclesSoftBody 真机编译;障碍 ABI 与布料核同构(64×80B,判别式 halfExtents.w=radius,跨核字节恒等锁);" +
      "A 公式级单入口投影 vs createSoftBodyStaticCollision f64 黄金(同 f32 入态);B GPU vs 色批序 f32 镜像(同编排);" +
      "C 有/无障碍黄金对照列(如实边界:并行色批序 vs 串行构建序存在投影序相关平衡态差异,先于障碍刀);D 接触可观测 min|dist−r|",
    adapter, projection, replay, variantMatrix, uncapturedGpuErrors: result.uncapturedGpuErrors ?? [],
    verdict: {
      formulaGoldenWithinTolerance: projection.sphereWithinTolerance === true && projection.cuboidWithinTolerance === true,
      actualDispatchObserved: projection.directPassExecuted === true && projection.integrateDirectExecuted === true,
      gpuValidationClean: (result.uncapturedGpuErrors ?? []).length === 0,
      mirrorWithinTolerance: replay.mirrorWithinTolerance === true,
      replayBitwise: replay.replayBitwise === true,
      contactObserved: replay.contactObserved === true,
      // 障碍核边际效应:有障碍黄金差 − 无障碍黄金差 ≤ 0.05(主体为既有投影序平衡态差异)。
      extraDivergenceWithinBand: replay.maxExtraDivergence <= 0.05,
    },
  };
  await mkdir(outputDirectory, { recursive: true });
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(adapter)}`);
  console.log(`[A 公式级] sphere(${projection.spherePoints}pts) maxErr=${projection.sphereMaxErr.toExponential(3)} ` +
    `cuboid(${projection.cuboidPoints}pts) maxErr=${projection.cuboidMaxErr.toExponential(3)} tol=${projection.tolerance} ` +
    `directPassObservation=${JSON.stringify(projection.directPassObservation ?? null)}`);
  for (const row of replay.per24) {
    console.log(`[B 镜像] tick ${row.tick}: maxErrVsMirror=${row.maxErrVsMirror.toExponential(3)} minSurfaceGap=${row.minSurfaceGap.toFixed(4)}`);
  }
  for (const row of replay.goldenColumns.extraDivergence) {
    console.log(`[C 黄金] tick ${row.tick}: withObstacles=${row.withObstacles.toFixed(4)} withoutObstacles=${row.withoutObstacles.toFixed(4)} extra=${row.extra.toFixed(4)}`);
  }
  console.log(`[D 接触] minSurfaceGap=${replay.minSurfaceGap.toFixed(4)} (<${replay.contactThreshold}) golden=${replay.goldenMinSurfaceGap.toFixed(4)}; ` +
    `replayBitwise=${replay.replayBitwise} maxExtraDivergence=${replay.maxExtraDivergence.toFixed(4)}`);
  console.log(`uncapturedGpuErrors: ${JSON.stringify(result.uncapturedGpuErrors ?? [])}`);
  console.log(`evidence: ${evidencePath} (sha256=${sha256(await readFile(evidencePath))})`);
  const v = evidence.verdict;
  const pass = sourceIdentityStable && v.formulaGoldenWithinTolerance && v.actualDispatchObserved && v.gpuValidationClean && v.mirrorWithinTolerance && v.replayBitwise && v.contactObserved && v.extraDivergenceWithinBand;
  if (!pass) process.exitCode = 1;
  else console.log("verdict: PASS(公式级黄金/镜像合同/双跑逐位/接触可观测/边际发散带 全部成立)");
}

await main();
