import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// T05 验收切片：10,000 实例工厂 fixture 的 CPU 提交 A/B（T00 基线提交路径 vs 当前剔除提交路径）。
// 分母口径：T00 基线提交路径 = 当前代码、features.occlusionCulling=false（T11 fair 同款
// baseline-equivalent 提交合同，唯一 T05 之前存在的提交路径）；分子 = 同合同开
// occlusionCulling=true。其余画质/阴影/相机字段逐项相同，单开关归因。
// 协议：≥3 次独立 Chrome 冷启动；每次页内 5 个交替顺序轮（base→culled / culled→base 交错），
// 每轮 20 帧预热 + 90 个 render() CPU 采样（P50/95/99）；draw calls 从 FrameMetrics 读取。
// 判定纪律：只记录实测值；"较 T00 降低 ≥50%" 未达标时如实报告实测降幅。

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(webRoot, "../..");
const outputDirectory = path.resolve(process.env.T05_SUBMIT_OUTPUT_DIR
  ?? path.join(repoRoot, "test-output", "deep-core", "T05", "culling-submit-r1"));
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const glbPath = path.join(repoRoot, "packages", "deep-engine", "lab", "assets", "FactoryMachine.glb");
const ROUNDS = Number(process.env.T05_SUBMIT_ROUNDS ?? 5);
const WARMUP = Number(process.env.T05_SUBMIT_WARMUP ?? 20);
const SAMPLES = Number(process.env.T05_SUBMIT_SAMPLES ?? 90);
const ITERATIONS = Number(process.env.T05_SUBMIT_ITERATIONS ?? 3);

const requireFromEngine = createRequire(path.join(repoRoot, "packages", "deep-engine", "package.json"));
const { build } = requireFromEngine("esbuild");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function startServer(entryBundle) {
  const glb = await readFile(glbPath);
  const html = `<!doctype html><html><head><title>T05 submit probe</title></head>
<body><script type="module">import "${`/probe.bundle.mjs`}";</script></body></html>`;
  const server = createServer((request, response) => {
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("Cache-Control", "no-store");
    if (name === "/probe.bundle.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript" }).end(entryBundle);
    } else if (name === "/assets/FactoryMachine.glb") {
      response.writeHead(200, { "Content-Type": "model/gltf-binary",
        "X-Deep-Source-Sha256": sha256(glb) }).end(glb);
    } else if (name === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runInBrowser(origin) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", error => errors.push(`page: ${error.message}`));
    page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    await page.goto(origin, { waitUntil: "load", timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__t05SubmitProbe?.run === "function", undefined, { timeout: 30_000 });
    return await page.evaluate(({ rounds, warmup, samples }) => window.__t05SubmitProbe.run(rounds, warmup, samples),
      { rounds: ROUNDS, warmup: WARMUP, samples: SAMPLES });
  } finally { await browser.close(); }
}

async function main() {
  await mkdir(outputDirectory, { recursive: true });
  const bundled = await build({ absWorkingDir: webRoot,
    entryPoints: [path.resolve(webRoot, "..", "..", "packages", "deep-engine", "lab", "probeT05SubmitEntry.ts")],
    bundle: true, format: "esm", target: "es2022", write: false, logLevel: "silent", conditions: ["development"] });
  const entryBundle = bundled.outputFiles[0].text;
  const iterations = [];
  for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
    const { server, origin } = await startServer(entryBundle);
    try {
      const probe = await runInBrowser(origin);
      iterations.push({ iteration, origin, ...probe,
        browserErrors: probe.errors.filter(error => !error.startsWith("console")) });
      console.log(JSON.stringify({ iteration,
        baselineP95: probe.rounds.map(round => round.baseline.p95),
        culledP95: probe.rounds.map(round => round.culled.p95),
        drawCalls: probe.rounds.map(round => [round.baseline.drawCalls, round.culled.drawCalls]),
        occlusionActive: probe.rounds.map(round => round.culledOcclusionActive) }));
    } catch (error) {
      iterations.push({ iteration, error: String(error instanceof Error ? error.message : error) });
      console.log(JSON.stringify({ iteration, error: iterations.at(-1).error }));
    } finally { server.close(); }
  }
  const ok = iterations.every(entry => entry.rounds);
  if (!ok) {
    await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify({ schema: "t05-culling-submit-v1", iterations }, null, 2)}
`);
    console.log(`probe failed; evidence: ${outputDirectory}`);
    process.exitCode = 1;
    return;
  }
  const baselineAll = iterations.flatMap(entry => entry.rounds.map(round => round.baseline.p95));
  const culledAll = iterations.flatMap(entry => entry.rounds.map(round => round.culled.p95));
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const baselineMedian = median(baselineAll), culledMedian = median(culledAll);
  const reduction = (baselineMedian - culledMedian) / baselineMedian;
  const drawCallPairs = iterations.flatMap(entry => entry.rounds
    .map(round => [round.baseline.drawCalls, round.culled.drawCalls]));
  const drawCallsIncreased = drawCallPairs.some(([base, culled]) => culled > base);
  const report = { schema: "t05-culling-submit-v1", createdAt: new Date().toISOString(),
    protocol: { iterations: ITERATIONS, roundsPerIteration: ROUNDS, warmupFrames: WARMUP, cpuSamples: SAMPLES,
      denominator: "T00 基线提交路径 = features.occlusionCulling=false（T11 fair baseline-equivalent 提交合同）；单开关 A/B" },
    iterations, verdict: { ok, baselineP95MedianMs: baselineMedian, culledP95MedianMs: culledMedian,
      reductionFraction: reduction, targetFraction: 0.5, reductionTargetMet: reduction >= 0.5,
      drawCallsIncreased, allOcclusionActive: iterations.every(entry => entry.rounds
        ? entry.rounds.every(round => round.culledOcclusionActive) : false) } };
  await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`T00 口径基线 P95 中位 ${baselineMedian.toFixed(3)}ms → 剔除路径 ${culledMedian.toFixed(3)}ms：` +
    `降幅 ${(reduction * 100).toFixed(1)}%（目标 ≥50%）；draw calls 增加=${drawCallsIncreased}；` +
    `evidence: ${outputDirectory}${path.sep}report.json verdict.ok=${ok}`);
  if (!ok) process.exitCode = 1;
}

await main();
