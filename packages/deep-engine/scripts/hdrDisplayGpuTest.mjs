import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// I-C21 HDR 显示输出真机验收 runner(形态沿用 atmosphereSkyGpuTest.mjs):
//   1) detect 腿:matchMedia dynamic-range + rgba16float canvas / toneMapping extended
//      试配置(逐项显式原因)→ resolveHdrDisplayPolicy 真实输入与结论;
//   2) sdr-vs-{extended-linear,pq-2020,hlg-2020} 腿:同一 0..8 线性 HDR 斜坡分别经
//      既有 SDR outputShader 与 HDR 变体管线渲到离屏目标读回 —— 亮度/色域数值对照 +
//      GPU↔CPU 编码镜像对拍(1% 容差);
//   3) furnace 腿:PbrRenderer 全管线(默认关,被改的 PbrOutputBindings 在链上)白炉
//      present-color 守恒 + 0.5 灰 HDR 编码往返(能量链零放大的真机证据);
//   4) 截图:SDR/HDR 演示画布 playwright 截图存证(canvas HDR 不可用时 fail-closed 全
//      SDR,截图与探测记录一致)。
// 证据写入 test-output/hdr-display-gpu-20260929-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.HDR_DISPLAY_GPU_OUTPUT_DIR
  ? path.resolve(process.env.HDR_DISPLAY_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "hdr-display-gpu-20260929-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.HDR_DISPLAY_GPU_TEST_ATTEMPTS ?? 3);
const STRATEGIES = ["extended-linear", "pq-2020", "hlg-2020"];

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
    const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    page.on("console", (message) => { if (message.text().includes("[hdr-probe]")) console.log(message.text()); });
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const detection = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeHdrDetection());
    const legs = [], errors = [];
    for (const strategy of [...STRATEGIES, "furnace"]) {
      try {
        const leg = await page.evaluate(async ([kind]) => {
          const module = await import("./probe.bundle.mjs");
          return kind === "furnace" ? module.runFurnaceLeg() : module.runStrategyLeg(kind);
        }, [strategy]);
        legs.push(leg);
      } catch (error) {
        errors.push(`${strategy}: ${error instanceof Error ? error.message : error}`);
        legs.push({ strategy, checks: [{ name: "leg-ran", passed: false,
          detail: error instanceof Error ? error.message : String(error) }] });
      }
    }
    let demoCanvases = [], shotBase64 = null;
    try {
      demoCanvases = await page.evaluate(async () => (await import("./probe.bundle.mjs")).buildDemoCanvases());
      shotBase64 = (await page.screenshot({ type: "png" })).toString("base64");
    } catch (error) {
      errors.push(`screenshot: ${error instanceof Error ? error.message : error}`);
    }
    return { adapter, detection, legs, demoCanvases, shotBase64, errors };
  } finally { await browser.close(); }
}

function analyse(probe) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  add("detect:ran", Boolean(probe.detection), JSON.stringify(probe.detection?.policy ?? probe.errors));
  for (const leg of probe.legs) {
    for (const check of leg.checks) add(`${leg.strategy}:${check.name}`, check.passed, check.detail);
  }
  add("demo:canvases", probe.demoCanvases.length === 3,
    probe.demoCanvases.map((canvas) => canvas.label).join(","));
  add("demo:pngs-captured", probe.demoCanvases.every((canvas) => canvas.png?.startsWith("data:image/png")),
    `bytes=${probe.demoCanvases.map((canvas) => canvas.png?.length ?? 0).join("/")}`);
  // 判据语义:每条 check 自带判据;gate = 全部通过。
  // 注意:detect 腿的 fail-closed(如 headless 显示器非 HDR)不是失败 —— 策略门按
  // 原因码显式回 SDR 正是能力语义;真 HDR 环境的对照数值由离屏 rgba16float 腿量化。
  return { checks, gate: checks.every((check) => check.passed) };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "hdr-display-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/hdrDisplayGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>HDR display GPU probe</title></head><body></body></html>`);

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { adapter: {}, detection: null, legs: [], demoCanvases: [], shotBase64: null,
        errors: [String(error instanceof Error ? error.message : error)] };
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`HDR display GPU probe failed after ${maxAttempts} attempts.`);

  const analysis = analyse(probe);
  await mkdir(outputDirectory, { recursive: true });
  const evidence = {
    schema: "deep-engine.ic21-hdr-display-gpu", date: new Date().toISOString(),
    chrome: { path: chromePath }, strategies: STRATEGIES,
    adapter: probe.adapter,
    detection: probe.detection,
    demoCanvases: probe.demoCanvases.map((canvas) => canvas.label),
    demoPngSha256: Object.fromEntries(probe.demoCanvases.map((canvas) =>
      [canvas.label, sha256(Buffer.from(canvas.png.replace(/^data:image\/png;base64,/, ""), "base64"))])),
    errors: probe.errors,
    legs: probe.legs.map((leg) => ({
      strategy: leg.strategy,
      checks: leg.checks,
      ...(leg.quantification ? { quantification: leg.quantification } : {}),
    })),
    screenshot: probe.shotBase64 ? sha256(Buffer.from(probe.shotBase64, "base64")) : null,
    checks: analysis.checks, gate: analysis.gate,
  };
  if (probe.shotBase64) {
    await writeFile(path.join(outputDirectory, "hdr-display-page.png"), Buffer.from(probe.shotBase64, "base64"));
  }
  for (const canvas of probe.demoCanvases) {
    await writeFile(path.join(outputDirectory, `demo-${canvas.label}.png`),
      Buffer.from(canvas.png.replace(/^data:image\/png;base64,/, ""), "base64"));
  }
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  console.log(`detection: ${JSON.stringify(probe.detection)}`);
  for (const check of analysis.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`gate: ${analysis.gate ? "PASS" : "FAIL"} — ${evidencePath}`);
  if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = analysis.gate ? 0 : 1;
}

await main();
