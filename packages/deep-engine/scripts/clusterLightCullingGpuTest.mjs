import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// I 级 C2 集群光源剔除真机验收 runner(headless Chrome WebGPU,模式沿用 instanceCullingGpuTest.mjs):
//   1) 正确性:光心剔除 GPU 输出 ↔ CPU 光心镜像 ↔ B1 簇心参考,16/100/1000/10000 灯 + 溢出 + 空场;
//   2) 帧时曲线:16/100/1000/10000 灯,逐灯 forward vs C2 集群(剔除 compute + 着色) wall-clock 对照,
//      附 B1 簇心分配 compute 单独计时(cluster-centric 成本对照);
//   3) 白炉多灯腿:E + 4 灯,能量守恒 + 色偏 + 剔除↔逐灯净差 p99 + 两腿 PNG 视觉对照。
// 证据:test-output/deep-core/C2/cluster-light-culling-r1/(evidence.json + 2×PNG + sha256)。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.resolve(process.env.CLUSTER_LIGHT_CULLING_GPU_OUTPUT_DIR
  ?? path.join(repoRoot, "test-output", "deep-core", "C2", "cluster-light-culling-r1"));
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.CLUSTER_LIGHT_CULLING_GPU_ATTEMPTS ?? 3);
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
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runInBrowser(origin) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 400 } });
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message)));
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const evaluateProbe = async (name) => page.evaluate(async (probeName) => {
      const module = await import("./probe.bundle.mjs");
      try { return { ok: true, result: await module[probeName]() }; }
      catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error),
          stack: String(error instanceof Error ? error.stack ?? "" : "") };
      }
    }, name, { timeout: 420000 });
    const correctness = await evaluateProbe("runClusterLightCullingCorrectness");
    const benchmark = await evaluateProbe("runClusterLightCullingBenchmark");
    const furnace = await evaluateProbe("runClusterLightCullingFurnace");
    return { adapter, pageErrors, correctness, benchmark, furnace };
  } finally { await browser.close(); }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "cluster-light-culling-gpu-"));
  await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/clusterLightCullingGpuProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"] });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Cluster light culling GPU probe</title></head><body></body></html>`);
  let probe = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try { probe = await runInBrowser(origin); if (!probe.pageErrors.length) break; }
    catch (error) { probe = { error: String(error instanceof Error ? error.message : error) }; }
    finally { server.close(); }
    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  const failed = !probe || probe.error || probe.pageErrors?.length
    || !probe.correctness?.ok || !probe.benchmark?.ok || !probe.furnace?.ok;
  if (failed) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "probe-failure.json"), JSON.stringify(probe, null, 1));
    console.log(`cluster light culling GPU probe failed: ${JSON.stringify(probe)?.slice(0, 600)}`);
    process.exitCode = 1; return;
  }
  const { correctness, benchmark, furnace, adapter } = probe;
  await mkdir(outputDirectory, { recursive: true });
  const writePng = async (name, base64) => {
    const bytes = Buffer.from(base64, "base64");
    await writeFile(path.join(outputDirectory, name), bytes);
    return { file: name, sha256: sha256(bytes), bytes: bytes.length };
  };
  const screenshots = {
    perLight: await writePng("multi-light-per-light.png", furnace.result.perLightPngBase64),
    cluster: await writePng("multi-light-cluster.png", furnace.result.clusterPngBase64),
  };
  const curve = benchmark.result.legs.map(leg => ({ lightCount: leg.lightCount,
    perLightFrameMs: round(leg.perLightFrameMs), clusterFrameMs: round(leg.clusterFrameMs),
    prepareOnlyMs: round(leg.prepareOnlyMs), cullOnlyMs: round(leg.cullOnlyMs),
    cullGpuNetMs: round(Math.max(leg.cullOnlyMs - leg.prepareOnlyMs, 0)), b1AssignMs: round(leg.b1AssignMs),
    speedup: round(leg.perLightFrameMs / leg.clusterFrameMs), overflow: leg.overflow }));
  const evidence = {
    schema: "cluster-light-culling-gpu-evidence-v1", createdAt: new Date().toISOString(),
    lane: "i-level-C2-cluster-light-culling-real-gpu",
    method: "光心剔除(light-centric) compute 与 B1 簇心(cluster-centric)同 ABI 对照;wall-clock submit+done 口径",
    adapter, timingMethod: benchmark.result.timingMethod, viewport: benchmark.result.viewport,
    correctness: correctness.result, frameTimeCurve: curve, furnace: { ...furnace.result, perLightPngBase64: undefined, clusterPngBase64: undefined },
    screenshots,
    verdict: {
      correctness: correctness.result.success, benchmark: benchmark.result.success, furnace: furnace.result.success,
      all: correctness.result.success && benchmark.result.success && furnace.result.success,
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  for (const leg of correctness.result.legs) {
    console.log(`N=${leg.lightCount}: sets(full)=${leg.indexSetsMatchCpu} ` +
      `headers=${leg.headerCountsMatchCpu} overflow=${leg.gpuOverflow}/${leg.overflowMatchCpu}`);
  }
  console.log(`overflowLeg sets=${correctness.result.overflowLeg.indexSetsMatchCpu} overflow=${correctness.result.overflowLeg.gpuOverflow}; ` +
    `empty=${correctness.result.emptyLeg.indexSetsMatchCpu}; b1GpuExact=${correctness.result.b1GpuExactAt16}`);
  for (const row of curve) {
    console.log(`lights=${row.lightCount}: perLight=${row.perLightFrameMs}ms cluster=${row.clusterFrameMs}ms ` +
      `(cull=${row.cullOnlyMs}ms b1Assign=${row.b1AssignMs}ms) speedup=${row.speedup}x overflow=${row.overflow}`);
  }
  for (const check of furnace.result.checks) console.log(`furnace ${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  console.log(`verdict: ${evidence.verdict.all ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!evidence.verdict.all) process.exitCode = 1;
}

function round(value) { return Math.round(value * 1000) / 1000; }

await main();
