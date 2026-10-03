import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// advancedMaterials 真机验收 runner(形态沿用 clearcoatFurnaceGpuTest.mjs):
//   math    — WGSL 数学函数 compute 对拍 CPU 参考(three r185 逐式移植);
//   furnace — 球体白炉:stock 位级一致、sheen/iridescence 守恒、clearcoat/透射能量界、彩色 sheen 解析预测、体积衰减比;
//   direct  — 平面解析对拍:单太阳光下 sheen / iridescence / clearcoat 直射项逐像素对 CPU 预测;
//   timing  — 全帧 GPU 毫秒(stock off/adv/各特性)。证据写入 test-output/advanced-material-gpu-20261003/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.ADVANCED_MATERIAL_GPU_OUTPUT_DIR
  ? path.resolve(process.env.ADVANCED_MATERIAL_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "advanced-material-gpu-20261003");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.ADVANCED_MATERIAL_GPU_TEST_ATTEMPTS ?? 3);

const SHEEN_GRAY = { color: [0.8, 0.8, 0.8], roughness: 0.5 };
const SHEEN_COLOR = { color: [1, 0.5, 0.2], roughness: 0.3 };
const SHEEN_DIRECT = { color: [0.9, 0.6, 0.3], roughness: 0.4 };
const IRID = { factor: 1, ior: 1.3, thickness: 400 };
const VOLUME = { thickness: 1.2, attenuationColor: [0.3, 0.9, 0.5], attenuationDistance: 1.5 };
const furnace = (id, rest) => ({ id, shape: "sphere", env: 0.5, sun: false, roughness: 0.35, advancedRenderer: true, ...rest });
// 倾斜平面用更宽的底层高光瓣,保证镜面峰值附近有足够信号覆盖。
const directRoughness = (tilt) => (tilt === 0 ? 0.4 : 0.7);
// 倾斜平面的光向取"相机中心视线的镜面反射 + 横向偏移",镜面峰值落在视野内。
const mirrorLight = (tiltDeg) => {
  const t = (tiltDeg * Math.PI) / 180, n = [0, -Math.sin(t), Math.cos(t)], nv = n[2];
  const l = [0.25, 2 * nv * n[1], 2 * nv * n[2] - 1], length = Math.hypot(...l);
  return l.map((v) => v / length);
};
const direct = (id, tiltDeg, rest) => ({ id, shape: "plane", tiltDeg, env: 0.001, sun: true, roughness: directRoughness(tiltDeg),
  advancedRenderer: true, ...(tiltDeg === 0 ? {} : { toLight: mirrorLight(tiltDeg) }), ...rest });
const LEGS = [
  furnace("f-stock-off", { advancedRenderer: false }),
  furnace("f-stock-adv", {}),
  furnace("f-sheen-gray", { advanced: { sheen: SHEEN_GRAY }, roughness: 0.35 }),
  furnace("f-sheen-color", { advanced: { sheen: SHEEN_COLOR } }),
  furnace("f-sheen-untextured", { advanced: { sheen: SHEEN_GRAY }, textured: false }),
  furnace("f-irid", { advanced: { iridescence: IRID } }),
  furnace("f-coat", { coat: { factor: 1, roughness: 0.2 } }),
  furnace("f-trans", { transmission: 1 }),
  furnace("f-trans-vol", { transmission: 1, advanced: { volume: VOLUME } }),
  ...["off-1", "adv-1", "off-2", "adv-2"].map((tag) => furnace(`t-${tag}`, { advancedRenderer: tag.startsWith("adv"), measureFrames: 60, size: 960, timingOnly: true })),
  furnace("t-adv-sheen", { advanced: { sheen: SHEEN_GRAY }, measureFrames: 60, size: 960, timingOnly: true }),
  furnace("t-adv-irid", { advanced: { iridescence: IRID }, measureFrames: 60, size: 960, timingOnly: true }),
  furnace("t-adv-coat", { coat: { factor: 1, roughness: 0.2 }, measureFrames: 60, size: 960, timingOnly: true }),
  furnace("t-adv-trans", { transmission: 1, advanced: { volume: VOLUME }, measureFrames: 60, size: 960, timingOnly: true }),
  ...[0, 25].flatMap((tilt) => [
    direct(`d${tilt}-stock-off`, tilt, { advancedRenderer: false }),
    direct(`d${tilt}-stock-adv`, tilt, {}),
    direct(`d${tilt}-sheen`, tilt, { advanced: { sheen: SHEEN_DIRECT } }),
    direct(`d${tilt}-irid`, tilt, { advanced: { iridescence: IRID } }),
    direct(`d${tilt}-coat`, tilt, { coat: { factor: 1, roughness: 0.3 } }),
  ]),
];
const T = {
  mathWorstRel: 5e-3,
  stockParityAbs: 1e-3,
  untexturedParityAbs: 1e-3,
  furnaceMeanBand: [0.985, 1.015], furnaceExtremeBand: [0.95, 1.05],
  coatMeanBand: [0.96, 1.002], transMeanBand: [0.97, 1.03],
  sheenColorP95: 0.02, sheenColorMax: 0.05,
  volumeRatioBand: [0.88, 0.99],
  directP95Abs: 0.01, directMaxAbs: 0.03,
  frameCostMaxMs: 0.5,
};

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method !== "GET" || !["probe.html", "probe.bundle.mjs"].includes(name)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" })
      .end(await readFile(path.join(directory, name)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runInBrowser(origin) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 300 } });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") console.error(`[console.error] ${message.text()}`); });
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const call = (name, ...args) => page.evaluate(async ([fn, params]) => (await import("./probe.bundle.mjs"))[fn](...params), [name, args]);
    const adapter = await call("probeAdapterInfo");
    const math = await call("runMathHarness", 4096);
    const summaries = [], errors = [];
    for (const spec of LEGS) {
      try { summaries.push(await call("runLeg", spec)); } catch (error) { errors.push(`${spec.id}: ${String(error?.message ?? error)}`); }
    }
    let analyses = null;
    if (errors.length === 0) {
      analyses = {
        stockParity: await call("maxAbsDelta", "f-stock-off", "f-stock-adv"),
        untexturedParity: await call("maxAbsDelta", "f-sheen-gray", "f-sheen-untextured"),
        furnace: Object.fromEntries(await Promise.all(["f-stock-off", "f-stock-adv", "f-sheen-gray", "f-sheen-untextured", "f-irid", "f-coat", "f-trans", "f-trans-vol"]
          .map(async (id) => [id, await call("furnaceRatio", id)]))),
        sheenColor: await call("sheenColorFurnace", "f-stock-adv", "f-sheen-color", SHEEN_COLOR.color, SHEEN_COLOR.roughness),
        volume: await call("volumeAttenuationRatio", "f-trans", "f-trans-vol", VOLUME.thickness, VOLUME.attenuationColor, VOLUME.attenuationDistance),
        direct: {},
      };
      for (const tilt of [0, 25]) {
        analyses.direct[tilt] = {
          stockParity: await call("planeMaxAbsDelta", `d${tilt}-stock-off`, `d${tilt}-stock-adv`),
          sheen: await call("sheenDirectTransfer", `d${tilt}-stock-adv`, `d${tilt}-sheen`, tilt, SHEEN_DIRECT.color, SHEEN_DIRECT.roughness),
          irid: await call("iridescenceDirectTransfer", `d${tilt}-stock-adv`, `d${tilt}-irid`, tilt, directRoughness(tilt), IRID.ior, IRID.thickness),
          coat: await call("clearcoatDirectTransfer", `d${tilt}-stock-adv`, `d${tilt}-coat`, tilt, 1, 0.3),
        };
      }
    }
    let shot = null;
    try {
      await call("runShowcase");
      shot = (await page.locator("canvas").screenshot({ type: "png" })).toString("base64");
      await call("disposeShowcase");
    } catch (error) { errors.push(`showcase: ${String(error?.message ?? error)}`); }
    return { adapter, math, summaries, errors, analyses, shot };
  } finally { await browser.close(); }
}

function analyse(probe) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  const inBand = (value, [lo, hi]) => value >= lo && value <= hi;
  add("legs-ran", probe.summaries.length === LEGS.length && probe.errors.length === 0, probe.errors.join("; ") || `legs=${probe.summaries.length}/${LEGS.length}`);
  add("math-compiled", probe.math.errors.length === 0, probe.math.errors.join("; ") || `samples=${probe.math.samples}`);
  if (probe.math.errors.length === 0) {
    for (const [name, value] of Object.entries(probe.math.worstRelativeError)) {
      add(`math:${name}`, value <= T.mathWorstRel, `worstRel=${value.toExponential(3)} limit=${T.mathWorstRel}`);
    }
  }
  if (!probe.analyses) return { checks, gate: false };
  const a = probe.analyses;
  add("stock-parity(advanced 变体不改普通材质)", a.stockParity <= T.stockParityAbs, `maxAbsDelta=${a.stockParity.toExponential(3)} limit=${T.stockParityAbs}`);
  add("untextured≡textured(中性纹理承载)", a.untexturedParity <= T.untexturedParityAbs, `maxAbsDelta=${a.untexturedParity.toExponential(3)}`);
  const fmt = (f) => `mean=[${f.meanRatio.map((v) => v.toFixed(4)).join(",")}] min=${f.minRatio.toFixed(4)} max=${f.maxRatio.toFixed(4)} px=${f.pixels}`;
  for (const id of ["f-stock-off", "f-stock-adv", "f-sheen-gray", "f-sheen-untextured", "f-irid"]) {
    const f = a.furnace[id];
    add(`furnace-conserves:${id}`, f.meanRatio.every((v) => inBand(v, T.furnaceMeanBand)) && f.minRatio >= T.furnaceExtremeBand[0] && f.maxRatio <= T.furnaceExtremeBand[1], fmt(f));
  }
  const coat = a.furnace["f-coat"];
  add("furnace-coat-energy-bound", coat.meanRatio.every((v) => inBand(v, T.coatMeanBand)) && coat.maxRatio <= 1.01, fmt(coat));
  const trans = a.furnace["f-trans"];
  add("furnace-transmission-bound", trans.meanRatio.every((v) => inBand(v, T.transMeanBand)), fmt(trans));
  add("sheen-color-analytic", a.sheenColor.p95 <= T.sheenColorP95 && a.sheenColor.max <= T.sheenColorMax,
    `p95=${a.sheenColor.p95.toExponential(3)} max=${a.sheenColor.max.toExponential(3)} (相对 E)`);
  a.volume.channels.forEach((channel, index) => {
    if (channel.count === 0) return;
    add(`volume-attenuation-ratio:ch${index}`, inBand(channel.mean, T.volumeRatioBand),
      `mean=${channel.mean.toFixed(4)} [${channel.min.toFixed(4)},${channel.max.toFixed(4)}] n=${channel.count} A=${a.volume.attenuation[index].toFixed(4)}`);
  });
  for (const tilt of [0, 25]) {
    const d = a.direct[tilt];
    add(`direct${tilt}:stock-parity`, d.stockParity <= T.stockParityAbs, `maxAbsDelta=${d.stockParity.toExponential(3)}`);
    for (const key of ["sheen", "irid", "coat"]) {
      const s = d[key];
      add(`direct${tilt}:${key}`, s.abs.p95 <= T.directP95Abs && s.abs.max <= T.directMaxAbs && s.signal.max > 0.01,
        `absP95=${s.abs.p95.toExponential(3)} absMax=${s.abs.max.toExponential(3)} relP95=${s.rel.p95.toFixed(4)} signalMax=${s.signal.max.toFixed(4)} n=${s.abs.count}`);
    }
  }
  const gpu = (id) => probe.summaries.find((s) => s.id === id)?.gpuMs;
  const mean2 = (a, b) => a != null && b != null ? (a + b) / 2 : null;
  const off = mean2(gpu("t-off-1"), gpu("t-off-2")), adv = mean2(gpu("t-adv-1"), gpu("t-adv-2"));
  add("timing-captured", off != null && adv != null, `plain: advancedOff=${off?.toFixed(4)} advancedOn=${adv?.toFixed(4)} (960² 球体,无回读,中位数,60 帧 ×2 交替)`);
  if (off != null && adv != null) add("variant-plain-frame-cost-bounded", adv - off <= T.frameCostMaxMs, `delta=${(adv - off).toFixed(4)}ms limit=${T.frameCostMaxMs}`);
  for (const id of ["t-adv-sheen", "t-adv-irid", "t-adv-coat", "t-adv-trans"]) {
    const v = gpu(id);
    add(`timing:${id}`, v != null && adv != null && v - adv <= T.frameCostMaxMs, `gpu=${v?.toFixed(4)} vsPlainAdvanced=${v != null && adv != null ? (v - adv).toFixed(4) : "n/a"}ms`);
  }
  return { checks, gate: checks.every((check) => check.passed) };
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const bundleDirectory = path.join(outputDirectory, "_bundle");
  await mkdir(bundleDirectory, { recursive: true });
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/advancedMaterialGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"), logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"), `<!doctype html><html><head><title>Advanced material GPU probe</title></head><body></body></html>`);
  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try { probe = await runInBrowser(origin); if (probe.errors.length === 0) break; }
    catch (error) { probe = { adapter: {}, math: { errors: [String(error?.message ?? error)] }, summaries: [], errors: [String(error?.message ?? error)], analyses: null, shot: null }; }
    finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  const analysis = analyse(probe);
  if (probe.shot) await writeFile(path.join(outputDirectory, "showcase.png"), Buffer.from(probe.shot, "base64"));
  const evidence = { schema: "deep-engine.advanced-material-gpu", date: new Date().toISOString(), chrome: { path: chromePath },
    adapter: probe.adapter, thresholds: T, errors: probe.errors, math: probe.math,
    summaries: probe.summaries.map((s) => ({ ...s, gpuMs: s.gpuMs == null ? null : Number(s.gpuMs.toFixed(4)), cpuSubmitMs: s.cpuSubmitMs == null ? null : Number(s.cpuSubmitMs.toFixed(4)) })),
    analyses: probe.analyses, screenshot: probe.shot ? `showcase.png (sha256 ${createHash("sha256").update(probe.shot).digest("hex").slice(0, 16)}...)` : null,
    checks: analysis.checks, gate: analysis.gate };
  await writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  for (const check of analysis.checks) console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  console.log(`gate: ${analysis.gate ? "PASS" : "FAIL"} — ${path.join(outputDirectory, "evidence.json")}`);
  if (!analysis.gate) process.exitCode = 1;
}

await main();
