// F6/T18 风场刀:真机 WebGPU 组合对拍 runner(骨架同款 softBodyObstacleGpuTest.mjs)。
// esbuild 打包 softBodyWindCollisionGpuProbe.ts → 本地 http 服务 → playwright + headless
// Chrome(--enable-unsafe-webgpu)执行 → 证据落 test-output/softbody-wind-gpu-20261002/。
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
const outputDirectory = process.env.SOFTBODY_WIND_GPU_OUTPUT_DIR
  ? path.resolve(process.env.SOFTBODY_WIND_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "softbody-wind-gpu-20261002");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.SOFTBODY_WIND_GPU_ATTEMPTS ?? 2);
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
          softbody: await module.runSoftBodyWindCollisionCheck(),
          cloth: await module.runClothWindObstacleCheck(),
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
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "softbody-wind-gpu-"));
  const bundle = await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/softBodyWindCollisionGpuProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"], metafile: true });
  const sources = await Promise.all(Object.keys(bundle.metafile.inputs).map(async (name) => ({
    path: path.resolve(packageRoot, name), sha256: sha256(await readFile(path.resolve(packageRoot, name))),
  })));
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Softbody wind collision GPU probe</title></head><body></body></html>`);
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
    console.log(`softbody wind GPU probe: real device unavailable (${probe?.error ?? probe?.result?.error}). 真机留项如实记录。`);
    process.exitCode = 2; return;
  }
  const failed = !probe || probe.error || probe.pageErrors?.length || !probe.result?.ok;
  if (failed) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "probe-failure.json"), JSON.stringify(probe, null, 1));
    console.log(`softbody wind GPU probe failed: ${JSON.stringify(probe)?.slice(0, 1200)}`);
    process.exitCode = 1; return;
  }
  const { adapter, result } = probe;
  const softbody = result.softbody;
  const cloth = result.cloth;
  const sourceIdentityStable = (await Promise.all(sources.map(async (source) =>
    source.sha256 === sha256(await readFile(source.path))))).every(Boolean);
  const evidence = {
    schema: "softbody-wind-gpu-evidence-v1",
    sources, sourceIdentityStable,
    createdAt: new Date().toISOString(),
    lane: "f6-t18-wind-gpu-collision-real-device",
    method: "软体并行核:风+障碍同场景 GPU(dispatchSoftBodyParallelGpuStep,per-substep params 风副本)" +
      " vs 色批序 f32 镜像(mirrorSoftBodyParallelStep 同编排)逐 24 tick 同 checkpoint;零风+障碍退化列;" +
      "布料并行核:旗布+风+球 GPU(dispatchClothStepAuto) vs f64 黄金(ClothSolver wind+contacts 同式球面)逐 16 tick(容差 0.1=风场景登记口径)",
    adapter, softbody, cloth, uncapturedGpuErrors: result.uncapturedGpuErrors ?? [],
    verdict: {
      sourceIdentityStable,
      softbodyComboMirrorWithinTolerance: softbody.comboMirrorWithinTolerance === true,
      softbodyNoWindDegenerateWithinTolerance: softbody.noWindMirrorWithinTolerance === true,
      softbodyReplayBitwise: softbody.replayBitwise === true,
      softbodyWindEffective: softbody.windEffective === true,
      softbodyContactObserved: softbody.contactObserved === true,
      softbodyReadbackEvolved: softbody.combo?.digestEvolved === true,
      clothGoldenWithinTolerance: cloth.columnAGoldenWithinTolerance === true,
      clothFixtureValid: cloth.columnBFixtureValid === true,
      clothComboContactObserved: cloth.comboContactObserved === true,
      clothComboPreContactWithinTolerance: cloth.comboPreContactGoldenWithinTolerance === true,
      clothKernelParallelNoFallback: cloth.kernelParallelNoFallback === true,
      gpuValidationClean: (result.uncapturedGpuErrors ?? []).length === 0,
    },
  };
  await mkdir(outputDirectory, { recursive: true });
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(adapter)}`);
  console.log(`[软体 W2 组合] per24 vs 镜像:`);
  for (const row of softbody.combo.per24) {
    console.log(`  tick ${row.tick}: maxErrVsMirror=${row.maxErrVsMirror.toExponential(3)} minSurfaceGap=${row.minSurfaceGap.toFixed(4)}`);
  }
  console.log(`[软体 W5 零风] per24: ${(softbody.noWind.per24.map(r => r.maxErrVsMirror.toExponential(2))).join(" / ")}`);
  console.log(`[软体] windEffective=${softbody.windEffective} directionDot=${softbody.directionDot?.toFixed(4)} ` +
    `replayBitwise=${softbody.replayBitwise} contact=${softbody.contactObserved}(min=${softbody.combo.minSurfaceGap.toExponential(3)}) ` +
    `readbackEvolved=${softbody.combo.digestEvolved} comboDigest=${softbody.combo.digest} noWindDigest=${softbody.noWind.digest}`);
  const columnA = cloth.columns.A_windNoObstacle;
  const columnB = cloth.columns.B_noWindObstacle;
  const columnC = cloth.columns.C_windObstacleCombo;
  console.log(`[布料 A 有风无障碍] per8: ${columnA.per8.filter((_, i) => i % 3 === 2).map(r => `t${r.tick}=${r.maxErrVsGolden.toFixed(4)}`).join(" ")} final=${columnA.finalMaxErrVsGolden.toFixed(4)} tol=0.1`);
  console.log(`[布料 B 无风有障碍·夹具门] final=${columnB.finalMaxErrVsGolden.toFixed(4)} tol=0.1 contact=${columnB.contactObserved}(须 false:初始零穿透)`);
  console.log(`[布料 C 风+障碍组合] per8: ${columnC.per8.filter((_, i) => i % 3 === 2).map(r => `t${r.tick}=${r.maxErrVsGolden.toFixed(4)}${r.contactYet ? "*" : ""}`).join(" ")}` +
    ` final=${columnC.finalMaxErrVsGolden.toFixed(4)}(接触后混沌域登记值) preContactMax=${columnC.maxPreContactErrVsGolden.toFixed(4)}(≤0.1 门) contact=${columnC.contactObserved} kernel=${columnC.kernel}`);
  console.log(`uncapturedGpuErrors: ${JSON.stringify(result.uncapturedGpuErrors ?? [])}`);
  console.log(`evidence: ${evidencePath} (sha256=${sha256(await readFile(evidencePath))})`);
  const v = evidence.verdict;
  const pass = Object.values(v).every(Boolean);
  if (!pass) {
    console.log(`verdict: FAIL(${JSON.stringify(Object.fromEntries(Object.entries(v).filter(([, ok]) => !ok)))})`);
    process.exitCode = 1;
  } else console.log("verdict: PASS(软体风×障碍镜像合同/双跑逐位/风生效/接触可观测/零风退化 + 布料风×障碍黄金门 + GPU validation clean)");
}

await main();
