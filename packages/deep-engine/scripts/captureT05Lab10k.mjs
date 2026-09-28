import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const origin = process.env.DEEP_ENGINE_LAB_URL ?? "http://127.0.0.1:5295";
const output = path.resolve(process.env.T05_LAB_OUTPUT_DIR ?? "test-output/deep-core/T05/lab-10k-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", error => errors.push(`page: ${error.message}`));
page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
page.on("requestfailed", request => errors.push(`request: ${request.url()} ${request.failure()?.errorText ?? "unknown"}`));
const startedAt = new Date().toISOString();
let report;
try {
  await page.goto(`${origin}/benchmark`, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForFunction(() => typeof window.__deepCompetitiveBenchmark?.run === "function", undefined,
    { timeout: 30_000 });
  report = await page.evaluate(() => window.__deepCompetitiveBenchmark.run(10_000, "high-native"));
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  await page.locator("#candidate-canvas").screenshot({ path: path.join(output, "deep.png") });
  await page.locator("#reference-canvas").screenshot({ path: path.join(output, "three.png") });
  const pick = await page.evaluate(() => {
    const ray = { origin: [1.05, 0.74, 500], direction: [0, 0, -1] };
    const start = performance.now();
    const result = window.__deepCompetitiveBenchmark.pickDeep(ray.origin, ray.direction);
    return { ray, elapsedMs: performance.now() - start, result };
  });
  await writeFile(path.join(output, "pick.json"), `${JSON.stringify(pick, null, 2)}\n`);
  if (!pick.result.available || pick.result.hits[0]?.instanceId !== "instance-9950") {
    throw new Error("Rendered 10k packet did not preserve the expected picking instance ID.");
  }
  if (report.rounds.length !== 5 || report.fixture.instanceCount !== 10_000) {
    throw new Error("10k Lab returned a different fixture or incomplete rounds.");
  }
  console.log(JSON.stringify({ output, rounds: report.rounds.length, status: report.evaluation.status,
    outcome: report.evaluation.outcome, cpu: report.channelGaps.find(gap => gap.channel === "cpu-submit"),
    pickMs: pick.elapsedMs, pickId: pick.result.hits[0].instanceId, errors }));
} catch (error) {
  errors.push(error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
  throw error;
} finally {
  await writeFile(path.join(output, "run.json"), `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(),
    origin, chromePath, requested: { instances: 10_000, profile: "high-native" },
    completedRounds: report?.rounds.length ?? 0, errors }, null, 2)}\n`);
  await browser.close();
}
