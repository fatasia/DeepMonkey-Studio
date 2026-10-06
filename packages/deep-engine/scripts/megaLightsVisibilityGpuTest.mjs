import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// B2 MegaLights M2 生产帧 TLAS 供给收口(2026-10-05)真机门 runner(headless Chrome
// WebGPU;模式沿用 scripts/megaLightsGpuTest.mjs,只跑生产供给相关腿):
//   ⑦ visibilityPerf:5000 动态点光 @1080p,RIS 两趟 + 胜者遮挡 trace 三趟,双口径
//      四相位——先例口径(spatial off,同 M1 perf 腿)带 trace 绝对 p95 ≤ 20ms 门;
//      生产口径(spatial on,控制器缺省)trace 增量 p95 ≤ 4ms 披露(生产绝对帧时
//      先于本切片已 >20ms,空间复用主项,如实不混报);另要求哨兵零 + 掩码遮挡 >0;
//   ⑥ winnerVisibility:回归腿(单灯遮挡盒 oracle 对拍,证据链沿 M2)。
// 证据:test-output/megaLights-visibility-20261006/evidence.json。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.resolve(process.env.MEGALIGHTS_VIS_OUTPUT_DIR
  ?? path.join(repoRoot, "test-output", "megaLights-visibility-20261006"));
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.MEGALIGHTS_VIS_ATTEMPTS ?? 3);
const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

async function startServer(directory) {
  const { createServer } = await import("node:http");
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
          stack: String(error instanceof Error ? error.stack ?? "" : "").slice(0, 4000) };
      }
    }, name, { timeout: 600000 });
    return { adapter, pageErrors, consoleErrors,
      visibilityPerf: await evaluateProbe("runVisibilityPerf"),
      winnerVisibility: await evaluateProbe("runWinnerVisibility") };
  } finally { await browser.close(); }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "megalights-vis-"));
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/megaLightsGpuProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"] });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>MegaLights visibility supply GPU probe</title></head><body></body></html>`);
  let probe = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try { probe = await runInBrowser(origin); if (!probe.pageErrors.length) break; }
    catch (error) { probe = { error: String(error instanceof Error ? error.message : error) }; }
    finally { server.close(); }
    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error("MegaLights visibility probe produced no result.");
  if (!Array.isArray(probe.pageErrors)) {
    console.error(JSON.stringify(probe));
    throw new Error("MegaLights visibility probe failed: " + String(probe.error ?? "unknown"));
  }
  const perf = probe.visibilityPerf?.result ?? {};
  const visibility = probe.winnerVisibility?.result ?? {};
  const ok = probe.pageErrors.length === 0
    && probe.visibilityPerf?.ok === true && perf.pass === true
    && probe.winnerVisibility?.ok === true && visibility.pass !== false;
  const evidence = { action: "megalights-production-visibility-gpu", date: new Date().toISOString(),
    adapter: probe.adapter, pageErrors: probe.pageErrors, consoleErrors: probe.consoleErrors,
    visibilityPerf: probe.visibilityPerf, winnerVisibility: probe.winnerVisibility,
    gates: { precedentSpatialOffP95Ms: 20, productionTraceIncrementP95Ms: 4, overflowSentinel: 0,
      occludedFraction: ">0", winnerVisibilityRegression: true },
    success: ok };
  await mkdir(outputDirectory, { recursive: true });
  const json = JSON.stringify(evidence, null, 2);
  await writeFile(path.join(outputDirectory, "evidence.json"), json);
  console.log(`evidence: ${path.join(outputDirectory, "evidence.json")} (sha256 ${sha256(Buffer.from(json)).slice(0, 16)}...)`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  if (probe.consoleErrors?.length) console.log(`console: ${JSON.stringify(probe.consoleErrors)}`);
  console.log(`visibilityPerf: ${JSON.stringify(probe.visibilityPerf?.result ?? probe.visibilityPerf)}`);
  console.log(`winnerVisibility: ${JSON.stringify(probe.winnerVisibility?.result ?? probe.winnerVisibility)}`);
  if (!ok) { console.error("MegaLights production visibility acceptance FAILED"); process.exitCode = 1; }
}

await main();
