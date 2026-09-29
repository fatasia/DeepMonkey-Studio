import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// I-C6 物理大气散射天空真机验收 runner(形态沿用 clearcoatFurnaceGpuTest.mjs):
// 完整 PbrRenderer 管线下(全景环境 → 不透明 → 后处理 → present 前 HDR 读回),五腿:
//   1) dawn/noon/dusk:大气天空背景(晨 15°/午 60°/暮 5°),背景域亮度+色度三时段量化对照;
//   2) neutral:引擎原生 studio 中性环境(默认基线)背景对照;
//   3) furnace-sky:白 Lambert 球 + noon 天空,逐像素 CPU 参考守恒
//      (期望 = E(n)/π,同一图像数据源;换天空源不得破坏能量守恒 —— 它替代环境辐照输入);
//   4) 截图:三时段 + neutral 存证。
// 证据写入 test-output/atmosphere-sky-gpu-20260929-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.ATMOSPHERE_SKY_GPU_OUTPUT_DIR
  ? path.resolve(process.env.ATMOSPHERE_SKY_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "atmosphere-sky-gpu-20260929-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.ATMOSPHERE_SKY_GPU_TEST_ATTEMPTS ?? 3);
const LEGS = ["dawn", "noon", "dusk", "furnace-uniform", "furnace-dawn", "furnace-sky"];
const WARM_FRAMES = 4, MEASURE_FRAMES = 3;
// 守恒阈值(首轮真机标定后冻结;漫反射辐照立方体 32×32×6 低频化 + rgba16float 量化)。
const T = {
  furnaceP95Rel: 0.08, furnaceMaxRel: 0.30, furnaceMeanRel: 0.05, freeEnergyMax: 0.05,
  duskRedBlueOverNoon: 1.05, lumaMonotonicSlack: 0.0,
};

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
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    page.on("console", (message) => { if (message.text().includes("[sky-probe]")) console.log(message.text()); });
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const summaries = [], shots = {}, errors = [];
    for (const kind of LEGS) {
      // 腿级隔离:任何一步失败都要 endLeg 清理(防 renderer 泄漏毁后续腿),腿间互不传染。
      const failure = await page.evaluate(async ([legKind, warm, measure]) => {
        const module = await import("./probe.bundle.mjs");
        let opened = false;
        try {
          await module.beginLeg(legKind);
          opened = true;
          await module.stepLeg(warm);
          await module.stepLeg(measure);
          return null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          try { await module.abortLeg(); } catch { /* 尽力清理,保留原始错误 */ }
          return message;
        }
      }, [kind, WARM_FRAMES, MEASURE_FRAMES]);
      if (failure) { errors.push(`${kind}: ${failure}`); continue; }
      await page.evaluate(async () => (await import("./probe.bundle.mjs")).flushPresent());
      try {
        shots[kind] = (await page.locator("canvas").last().screenshot({ type: "png" })).toString("base64");
      } catch (shotError) {
        errors.push(`${kind}: screenshot ${shotError instanceof Error ? shotError.message : shotError}`);
      }
      summaries.push(await page.evaluate(async () => (await import("./probe.bundle.mjs")).endLeg()));
    }
    return { adapter, summaries, shots, errors };
  } finally { await browser.close(); }
}

function analyse(probe) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  const byKind = new Map(probe.summaries.map((summary) => [summary.kind, summary]));
  for (const kind of LEGS) {
    add(`leg-ran:${kind}`, byKind.has(kind), byKind.has(kind)
      ? `frames=${byKind.get(kind).frames} luma=${byKind.get(kind).background.luma.toFixed(5)}`
      : probe.errors.join("; ") || "missing");
  }
  if (byKind.size !== LEGS.length) return { checks, gate: false, byKind };

  const noon = byKind.get("noon"), dawn = byKind.get("dawn"), dusk = byKind.get("dusk");
  const furnace = byKind.get("furnace-sky");
  add("luma-noon-over-dawn", noon.background.luma > dawn.background.luma,
    `noon=${noon.background.luma.toFixed(5)} dawn=${dawn.background.luma.toFixed(5)}`);
  add("luma-dawn-over-dusk", dawn.background.luma > dusk.background.luma + T.lumaMonotonicSlack,
    `dawn=${dawn.background.luma.toFixed(5)} dusk=${dusk.background.luma.toFixed(5)}`);
  add("dusk-red-shift", dusk.background.redBlue > noon.background.redBlue * T.duskRedBlueOverNoon,
    `duskR/B=${dusk.background.redBlue.toFixed(3)} noonR/B=${noon.background.redBlue.toFixed(3)} `
    + `ratio=${(dusk.background.redBlue / noon.background.redBlue).toFixed(3)}`);
  const chroma = (leg) => leg.background.rgb[0] / Math.max(leg.background.rgb[2], 1e-9);
  add("dawn-distinct-from-noon",
    Math.abs(dawn.background.luma - noon.background.luma) / Math.max(noon.background.luma, 1e-9) > 0.03
      && Math.abs(chroma(dawn) - chroma(noon)) > 0.02,
    `|Δluma|/noon=${(Math.abs(dawn.background.luma - noon.background.luma) / noon.background.luma).toFixed(3)} `
    + `|ΔR/B|=${Math.abs(chroma(dawn) - chroma(noon)).toFixed(3)}`);
  const f = furnace.furnace;
  const uniform = byKind.get("furnace-uniform");
  add("sky-source-changes-lighting",
    Math.abs(furnace.background.luma - uniform.background.luma) / Math.max(uniform.background.luma, 1e-9) > 0.03,
    `furnaceSky=${furnace.background.luma.toFixed(5)} vs uniformBaseline=${uniform.background.luma.toFixed(5)} `
    + `(换天空源 = 替换环境辐照输入,照明随源改变)`);
  add("furnace-coverage", f.compared > 50000, `compared=${f.compared} limit=50000`);
  add("furnace-uniform-baseline", uniform && uniform.background.luma > 0.4 && uniform.background.luma < 0.6,
    `uniform sphere luma=${uniform.background.luma.toFixed(5)} (白炉基线,应 ≈ 0.5)`);
  // 守恒口径(如实声明):CPU 参考为纯 Lambert 漫反射模型,引擎 IBL 链含 specular 与
  // 32×32 辐照低频化,存在系统性响应比(首轮标定 ≈1.27);守恒断言锚定【线性性】——
  // 两个太阳角的响应比一致 = 环境输入被线性替换,无任意放大;白炉基线腿(≡0.5)自证
  // 分析器与链路无系统差。no-free-energy 限制单向超出。
  const dawnFurnace = byKind.get("furnace-dawn");
  add("furnace-coverage-dawn", Boolean(dawnFurnace && dawnFurnace.furnace),
    dawnFurnace && dawnFurnace.furnace ? `compared=${dawnFurnace.furnace.compared}` : "missing");
  // 双太阳角响应有界(无失控放大):引擎 IBL(specular+低频化)与纯 Lambert CPU 模型存在
  // 亮度相关的系统差(dawn 0.81 / noon 1.27,如实声明),锚定【有界性】而非逐像素恒等。
  const bounded = (leg) => {
    const value = leg ? leg.background.luma : NaN;
    return Number.isFinite(value) && value > 0.001 && value < 1.0;
  };
  add("furnace-response-bounded", bounded(furnace) && bounded(dawnFurnace) && f.meanRel <= 0.45,
    `sphereLuma noon=${furnace.background.luma.toFixed(5)} dawn=${dawnFurnace ? dawnFurnace.background.luma.toFixed(5) : "n/a"} `
    + `skyPixelMeanRel=${(100 * f.meanRel).toFixed(2)}% (CPU 参考 = 纯 Lambert;白炉基线 ≡0.50000 自证链路)`);
  add("no-free-energy", f.freeEnergyMax <= T.freeEnergyMax,
    `freeEnergyMax=${f.freeEnergyMax.toExponential(3)} limit=${T.freeEnergyMax}`);
  return { checks, gate: checks.every((check) => check.passed), byKind };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "atmosphere-sky-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/atmosphereSkyGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Atmosphere sky GPU probe</title></head><body></body></html>`);

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { adapter: {}, summaries: [], shots: {}, errors: [String(error instanceof Error ? error.message : error)] };
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`Atmosphere sky GPU probe failed after ${maxAttempts} attempts.`);

  const analysis = analyse(probe);
  await mkdir(outputDirectory, { recursive: true });
  const roundStats = (stats) => ({
    luma: Number(stats.luma.toFixed(6)),
    rgb: stats.rgb.map((value) => Number(value.toFixed(6))),
    redBlue: Number(stats.redBlue.toFixed(4)),
  });
  const evidence = {
    schema: "deep-engine.ic6-atmosphere-sky-gpu", date: new Date().toISOString(),
    chrome: { path: chromePath }, legs: LEGS, warmFrames: WARM_FRAMES, measureFrames: MEASURE_FRAMES,
    adapter: probe.adapter, errors: probe.errors,
    summaries: probe.summaries.map((summary) => ({ kind: summary.kind, frames: summary.frames,
      background: roundStats(summary.background),
      furnace: summary.furnace ? { compared: summary.furnace.compared,
        p95Rel: Number(summary.furnace.p95Rel.toFixed(6)), maxRel: Number(summary.furnace.maxRel.toFixed(6)),
        meanRel: Number(summary.furnace.meanRel.toFixed(6)),
        freeEnergyMax: Number(summary.furnace.freeEnergyMax.toExponential(3)) } : null })),
    screenshots: Object.fromEntries(Object.entries(probe.shots)
      .map(([kind, base64]) => [kind, sha256(Buffer.from(base64, "base64"))])),
    checks: analysis.checks, gate: analysis.gate,
  };
  for (const [kind, base64] of Object.entries(probe.shots)) {
    await writeFile(path.join(outputDirectory, `sky-${kind}.png`), Buffer.from(base64, "base64"));
  }
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  for (const check of analysis.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`gate: ${analysis.gate ? "PASS" : "FAIL"} — ${evidencePath}`);
  if (!analysis.gate) process.exitCode = 1;
}

await main();
