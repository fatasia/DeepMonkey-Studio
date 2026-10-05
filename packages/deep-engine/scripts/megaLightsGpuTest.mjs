import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

// B2 MegaLights M1 真机验收 runner(headless Chrome WebGPU,模式沿用 clusterLightCullingGpuTest.mjs):
//   ① perf:5000 动态点光(10% 移动)@1080p p95 ≤20ms;
//   ③ flicker:静态 + 固定种子逐帧差 p99 ≤2/255;
//   ④ area:64 面积光 LTC 交付核 GPU↔CPU RMS ≤1%;
//   ⑤ parity:8 灯穷举退化一致性(GPU↔CPU)+ RIS 无偏性烟雾;
//   ⑥ visibility:M2 胜者可见性射线(阴影区抑制 ≥98%/亮区相对差 ≤2%/哨兵零/帧时披露)。
// 证据:test-output/ue-class-b2/megalights-m1/evidence.json(含 adapter/legs/sha256)。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.resolve(process.env.MEGALIGHTS_GPU_OUTPUT_DIR
  ?? path.join(repoRoot, "test-output", "ue-class-b2", "megalights-m1"));
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.MEGALIGHTS_GPU_ATTEMPTS ?? 3);
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

async function runInBrowser(origin, goldenColor) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 400 } });
    const pageErrors = [], consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message)));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") consoleErrors.push(message.text());
    });
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const evaluateProbe = async (name) => page.evaluate(async (probeName) => {
      const module = await import("./probe.bundle.mjs");
      try { return { ok: true, result: await module[probeName]() }; }
      catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error),
          stack: String(error instanceof Error ? error.stack ?? "" : "") };
      }
    }, name, { timeout: 600000 });
    const perfFlicker = await evaluateProbe("runPerfFlicker");
    const areaLtc = await evaluateProbe("runAreaLtc");
    const parity = await evaluateProbe("runParity");
    const visibility = await evaluateProbe("runWinnerVisibility");
    // ⑤ 门:GPU 穷举数组 ↔ 黄金真值(node,f64 逐通道;相对 RMS ≤ 0.2%)。
    let parityGolden = null;
    if (parity?.ok && Array.isArray(parity.result?.gpuExhaustive)) {
      const gpu = parity.result.gpuExhaustive, goldenRgb = goldenColor.rgb;
      let squares = 0, energy = 0;
      const pixels = goldenColor.width * goldenColor.height;
      for (let pixel = 0; pixel < pixels; pixel++) {
        for (let channel = 0; channel < 3; channel++) {
          const difference = gpu[pixel * 4 + channel] - goldenRgb[pixel * 3 + channel];
          squares += difference * difference;
          energy += goldenRgb[pixel * 3 + channel] ** 2;
        }
      }
      const rms = Math.sqrt(squares / (pixels * 3));
      const relativeRms = Math.sqrt(squares / Math.max(energy, 1e-12));
      let risSquares = 0;
      if (Array.isArray(parity.result?.gpuRis)) {
        for (let pixel = 0; pixel < pixels; pixel++) {
          for (let channel = 0; channel < 3; channel++) {
            const difference = parity.result.gpuRis[pixel * 4 + channel] - goldenRgb[pixel * 3 + channel];
            risSquares += difference * difference;
          }
        }
      }
      const samples = [0, 107].map((pixel) => ({
        pixel, gpu: [0, 1, 2].map((c) => gpu[pixel * 4 + c]), golden: [0, 1, 2].map((c) => goldenRgb[pixel * 3 + c]) }));
      parityGolden = { rms, relativeRms, gate: 0.002, pass: relativeRms <= 0.002, samples,
        risSmokeRms: Math.sqrt(risSquares / (pixels * 3)), goldenSha256: sha256(Buffer.from(goldenRgb)) };
    }
    return { adapter, pageErrors, consoleErrors, perfFlicker, areaLtc, parity, parityGolden, visibility };
  } finally { await browser.close(); }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "megalights-gpu-"));
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/megaLightsGpuProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"] });
  // 黄金真值(node 引擎,vitest 同源):⑤ 退化对拍的 CPU 参考端。
  const goldenOutfile = path.join(bundleDirectory, "golden.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/megaLightsGolden.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: goldenOutfile,
    logLevel: "silent", conditions: ["development"] });
  const golden = await import(pathToFileURL(goldenOutfile).href);
  const goldenColor = golden.computeGoldenParityColor();
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>MegaLights M1 GPU probe</title></head><body></body></html>`);
  let probe = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try { probe = await runInBrowser(origin, goldenColor); if (!probe.pageErrors.length) break; }
    catch (error) { probe = { error: String(error instanceof Error ? error.message : error) }; }
    finally { server.close(); }
    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error("MegaLights GPU probe produced no result.");
  if (!Array.isArray(probe.pageErrors)) {
    console.error(JSON.stringify(probe));
    throw new Error("MegaLights GPU probe failed: " + String(probe.error ?? "unknown"));
  }
  const legs = [probe.perfFlicker, probe.areaLtc, probe.parity, probe.visibility];
  const ok = probe.pageErrors.length === 0 && legs.every(leg => leg?.ok && leg.result?.perfPass !== false
    && leg.result?.flicker?.pass !== false && leg.result?.pass !== false)
    && probe.perfFlicker?.result?.perfPass !== false
    && probe.parityGolden?.pass === true && probe.areaLtc?.result?.pass === true
    && probe.visibility?.result?.pass === true;
  const evidence = { action: "megalights-m1-gpu-acceptance", date: new Date().toISOString(),
    adapter: probe.adapter, pageErrors: probe.pageErrors, consoleErrors: probe.consoleErrors,
    perfFlicker: probe.perfFlicker, areaLtc: probe.areaLtc, parity: probe.parity, parityGolden: probe.parityGolden,
    visibility: probe.visibility,
    gates: { perfP95Ms: 20, flickerP99: 2 / 255, areaRmse: 0.01, parityRelativeRms: 0.002,
      visibilitySuppression: 0.02, visibilityLitRelativeDiff: 0.02, visibilityOverflowSentinel: 0 },
    success: ok };
  await mkdir(outputDirectory, { recursive: true });
  const json = JSON.stringify(evidence, null, 2);
  await writeFile(path.join(outputDirectory, "evidence.json"), json);
  console.log(`evidence: ${path.join(outputDirectory, "evidence.json")} (sha256 ${sha256(Buffer.from(json)).slice(0, 16)}...)`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  if (probe.consoleErrors?.length) console.log(`console: ${JSON.stringify(probe.consoleErrors)}`);
  console.log(`perf/flicker: ${JSON.stringify(probe.perfFlicker?.result ?? probe.perfFlicker)}`);
  console.log(`areaLtc: ${JSON.stringify(probe.areaLtc?.result ?? probe.areaLtc)}`);
  console.log(`parityGolden: ${JSON.stringify(probe.parityGolden)}`);
  console.log(`visibility: ${JSON.stringify(probe.visibility?.result ?? probe.visibility)}`);
  if (!ok) { console.error("MegaLights GPU acceptance FAILED"); process.exitCode = 1; }
}

await main();
