import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import sharp from "sharp";
import { compareImageFiles } from "./renderImageSimilarity.mjs";

// T11 公平基线补测（T00 工厂 fixture）：Deep WebGPU vs Three.js WebGPU 同画质配对。
// 资产：Kenney FactoryMachine.glb × 10,000 实例（T00 冻结 packet，2,680,003 三角形，3 draws）。
// 协议：3 次独立 Chrome 冷启动；每次冷启动页内先跑一次「冷」配对（新 GPUDevice + 冷驱动
// 管线缓存），再在同页跑一次「暖」配对（同 Chrome 进程、驱动/JIT 热、设备仍新建）。
// 每次配对含 5 个交替顺序轮次，输出 CPU 帧时 P50/P95/P99 与逐轮感知相似度。
// 判定纪律：相似度 <0.92 只记录数据，不宣称性能领先；本脚本不产出 exceeds 结论。

const origin = process.env.DEEP_ENGINE_LAB_URL ?? "http://127.0.0.1:5291";
const output = path.resolve(process.env.T11_FAIR_OUTPUT_DIR ?? "../test-output/deep-core/T11/factory-fair");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const coldWarmPairs = Number(process.env.T11_FAIR_PAIRS ?? 3);
const instanceCount = Number(process.env.T11_FAIR_INSTANCES ?? 10_000);
const profile = process.env.T11_FAIR_PROFILE ?? "baseline-equivalent";
await mkdir(output, { recursive: true });

const report = { schema: "t11-factory-fair-v1", origin, instanceCount, profile, iterations: [] };
for (let iteration = 1; iteration <= coldWarmPairs; iteration++) {
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", error => errors.push(`page: ${error.message}`));
    page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
    page.on("requestfailed", request => errors.push(`request: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`));
    await page.goto(`${origin}/benchmark`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForFunction(() => typeof window.__deepCompetitiveBenchmark?.run === "function", undefined, { timeout: 30_000 });
    // run() 从 DOM 读取资产选择：T00 冻结的 Kenney FactoryMachine.glb 工业机器。
    await page.locator("#asset").selectOption("FactoryMachine");
    for (const condition of ["cold", "warm"]) {
      const run = await page.evaluate(({ instanceCount, profile }) =>
        window.__deepCompetitiveBenchmark.run(instanceCount, profile), { instanceCount, profile });
      const entry = { iteration, condition, errors: [...errors], run };
      if (condition === "cold") {
        const candidate = await page.locator("#candidate-canvas").screenshot();
        const reference = await page.locator("#reference-canvas").screenshot();
        const candidatePath = path.join(output, `iter${iteration}-deep.png`);
        const referencePath = path.join(output, `iter${iteration}-three.png`);
        await sharp(candidate).toFile(candidatePath);
        await sharp(reference).toFile(referencePath);
        const similarity = await compareImageFiles(candidatePath, referencePath, `iter${iteration}-deep`, `iter${iteration}-three`);
        entry.frozenFrameSimilarity = { ssim: Number(similarity.ssim.toFixed(4)),
          meanAbsoluteError: Number(similarity.meanAbsoluteError.toFixed(5)) };
      }
      report.iterations.push(entry);
      console.log(JSON.stringify({ iteration, condition, rounds: run.rounds.length,
        candidateP95: run.rounds.map(round => round.candidate.cpuFrameP95Ms),
        referenceP95: run.rounds.map(round => round.reference.cpuFrameP95Ms),
        similarity: run.rounds.map(round => round.visualSimilarity),
        evaluation: run.evaluation.status, frozen: entry.frozenFrameSimilarity ?? null }));
    }
  } finally { await browser.close(); }
}
await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, iterations: report.iterations.length }));
