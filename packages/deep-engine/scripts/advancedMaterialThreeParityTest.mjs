import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// three r185 ↔ Deep 真 GPU 对拍(直射光无环境,线性 HDR):逐特性比较 (feature − stock) 增量在两端的一致性。
// 证据写入 test-output/advanced-material-gpu-20261003/three-parity.json。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.ADVANCED_MATERIAL_GPU_OUTPUT_DIR
  ? path.resolve(process.env.ADVANCED_MATERIAL_GPU_OUTPUT_DIR) : path.join(repoRoot, "test-output", "advanced-material-gpu-20261003");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const T = { deltaRelRmse: 0.1, deltaMaxRel: 0.35, minSignal: 0.01 };

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const bundleDirectory = path.join(outputDirectory, "_bundle-parity");
  await mkdir(bundleDirectory, { recursive: true });
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/advancedMaterialThreeParityProbe.ts"], bundle: true, format: "esm",
    platform: "browser", conditions: ["development"], target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"), logLevel: "silent" });
  const html = "<!doctype html><html><head><title>three parity</title></head><body></body></html>";
  const server = createServer(async (request, response) => {
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (name === "probe.bundle.mjs") response.writeHead(200, { "Content-Type": "text/javascript" }).end(await readFile(path.join(bundleDirectory, name)));
    else response.writeHead(200, { "Content-Type": "text/html" }).end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
  let run, failure;
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
    run = await page.evaluate(async () => (await import("./probe.bundle.mjs")).runPhysicalParity());
  } catch (error) { failure = String(error?.message ?? error); }
  finally { await browser.close(); server.close(); await rm(bundleDirectory, { recursive: true, force: true }); }
  if (failure) { console.log(`FAIL parity-run: ${failure}`); process.exitCode = 1; return; }

  const luma = (p, i) => 0.2126 * p[i * 3] + 0.7152 * p[i * 3 + 1] + 0.0722 * p[i * 3 + 2];
  const count = run.width * run.height, byId = Object.fromEntries(run.results.map((r) => [r.id, r]));
  const stock = byId.stock;
  const checks = [], report = {};
  const rmse = (a, b, mask) => { let s = 0, n = 0; for (const i of mask) for (let c = 0; c < 3; c++) { s += (a[i * 3 + c] - b[i * 3 + c]) ** 2; n++; } return Math.sqrt(s / Math.max(n, 1)); };
  const mask = []; for (let i = 0; i < count; i++) if (luma(stock.three, i) > 0.01 && luma(stock.deep, i) > 0.01) mask.push(i);
  report.stock = { pixels: mask.length, rmse: rmse(stock.three, stock.deep, mask),
    meanThree: mask.reduce((s, i) => s + luma(stock.three, i), 0) / mask.length, meanDeep: mask.reduce((s, i) => s + luma(stock.deep, i), 0) / mask.length };
  for (const item of run.results) {
    if (item.id === "stock") continue;
    const dT = new Float32Array(count * 3), dD = new Float32Array(count * 3);
    for (let i = 0; i < count * 3; i++) { dT[i] = item.three[i] - stock.three[i]; dD[i] = item.deep[i] - stock.deep[i]; }
    let signal = 0, err = 0, maxAbs = 0, maxSignal = 0, n = 0;
    for (const i of mask) for (let c = 0; c < 3; c++) {
      const t = dT[i * 3 + c], d = dD[i * 3 + c]; signal += t * t; err += (t - d) ** 2; n++;
      maxAbs = Math.max(maxAbs, Math.abs(t - d)); maxSignal = Math.max(maxSignal, Math.abs(t));
    }
    const rmsSignal = Math.sqrt(signal / n), rmsError = Math.sqrt(err / n);
    const total = rmse(item.three, item.deep, mask);
    report[item.id] = { rmsSignal, rmsError, deltaRelRmse: rmsError / Math.max(rmsSignal, 1e-9), maxAbs, maxSignal, totalRmse: total };
    checks.push({ name: `delta-parity:${item.id}`, passed: rmsSignal >= T.minSignal * 0.1 && rmsError / Math.max(rmsSignal, 1e-9) <= T.deltaRelRmse && maxAbs <= T.deltaMaxRel * Math.max(maxSignal, 1e-9),
      detail: `deltaRelRmse=${(rmsError / Math.max(rmsSignal, 1e-9)).toFixed(4)} rmsSignal=${rmsSignal.toExponential(3)} rmsErr=${rmsError.toExponential(3)} maxAbs=${maxAbs.toExponential(3)} maxSignal=${maxSignal.toExponential(3)} totalRmse=${total.toExponential(3)}` });
  }
  const gate = checks.every((c) => c.passed);
  await writeFile(path.join(outputDirectory, "three-parity.json"), `${JSON.stringify({ schema: "deep-engine.advanced-material-three-parity", date: new Date().toISOString(), thresholds: T, report, checks, gate }, null, 2)}\n`);
  console.log(`stock diagnostic: rmse=${report.stock.rmse.toExponential(3)} meanLuma three=${report.stock.meanThree.toFixed(4)} deep=${report.stock.meanDeep.toFixed(4)} px=${report.stock.pixels}`);
  for (const c of checks) console.log(`${c.passed ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
  console.log(`gate: ${gate ? "PASS" : "FAIL"}`);
  if (!gate) process.exitCode = 1;
}
await main();