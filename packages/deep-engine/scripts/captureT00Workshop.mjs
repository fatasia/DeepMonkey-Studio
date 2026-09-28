import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import playwright from "../../../apps/cloud-render-worker/node_modules/playwright-core/index.js";

/**
 * T00 多资产车间三轮冷/热配对采集:
 * 每档(1,000/5,000/10,000 总实例)× 3 轮 × (新页面 cold + 同页 warm),
 * 记录加载/创建/首帧耗时、CPU 与 GPU 时间戳分位数、渲染器驻留快照(deviceMemory)、
 * performance.memory JS 堆、画面哈希与轨迹确定性,原始 JSON + 截图落 docs/reports/deep-core/assets/。
 */
const directory = fileURLToPath(new URL(".", import.meta.url));
const engineRoot = join(directory, "..");
const output = process.argv[2] ?? "docs/reports/deep-core/assets/t00-workshop-browser-2026-09-27.json";
const chromeArgs = ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--enable-precise-memory-info"];

const bundle = await build({ absWorkingDir: engineRoot, entryPoints: ["lab/t00WorkshopProbe.ts"],
  bundle: true, format: "iife", platform: "browser", target: "es2022", conditions: ["development"], write: false });

const listen = port => new Promise(resolve => {
  const server = net.createServer();
  server.once("error", () => resolve(false));
  server.once("listening", () => server.close(() => resolve(true)));
  server.listen(port, "127.0.0.1");
});
let port = Number(process.env.DEEP_ENGINE_LAB_PORT ?? 0);
if (!port) { for (let candidate = 5311; candidate < 5331; candidate++) { if (await listen(candidate)) { port = candidate; break; } } }
if (!port) throw new Error("No free lab port found in 5311..5330.");

const server = spawn(process.execPath, [join(engineRoot, "scripts", "serveLab.mjs")],
  { cwd: engineRoot, env: { ...process.env, DEEP_ENGINE_LAB_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
const origin = `http://127.0.0.1:${port}`;
const serverOutput = [];
server.stdout.on("data", chunk => serverOutput.push(chunk.toString()));
server.stderr.on("data", chunk => serverOutput.push(chunk.toString()));
const waitForServer = async () => {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`${origin}/benchmark`);
      if (response.ok) {
        const html = await response.text();
        // 并行会话可能把 dist/lab 回写成陈旧构建;证据页必须包含本切片的资产与轨迹选项。
        if (html.includes("FactoryWorkshop") && html.includes("workshop-tour-20s")) return;
      }
    } catch { /* not up yet or stale rebuild in progress */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Lab server did not serve a build containing the workshop fixture: ${serverOutput.join("")}`);
};

const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
  ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: chromeArgs });
const result = { schema: 1, date: new Date().toISOString(), origin, chromeArgs, browser: null,
  buildSha256: null, tiers: {}, pageErrors: [], serverLog: serverOutput };
try {
  await waitForServer();
  result.buildSha256 = (await (await fetch(`${origin}/manifest.json`)).json()).sha256;
  const page0 = await browser.newPage();
  result.browser = browser.version();
  await page0.close();
  for (const count of [1_000, 5_000, 10_000]) {
    const tier = { rounds: [], fixtureSha256: null, assetManifest: null, trajectoryReplay: null, screenshots: {} };
    for (let round = 1; round <= 3; round++) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on("pageerror", error => result.pageErrors.push({ count, round, message: String(error) }));
      await page.goto(`${origin}/benchmark`, { waitUntil: "networkidle" });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const cold = await page.evaluate(async request => await globalThis.__t00Workshop(request),
        { count, phase: "cold", identity: round === 1 });
      const warm = await page.evaluate(async request => await globalThis.__t00Workshop(request), { count, phase: "warm" });
      tier.rounds.push({ round, cold, warm });
      if (round === 1) {
        tier.fixtureSha256 = cold.fixtureSha256 ?? null;
        tier.assetManifest = cold.assetManifest ?? null;
        tier.trajectoryReplay = await page.evaluate(async value => await globalThis.__t00WorkshopTrajectory(value), count);
        await page.evaluate(async request => await globalThis.__t00WorkshopDispose(), { count });
      }
      if (round === 3) {
        const base = output.replace(/\.json$/, `-${count}`);
        const status = page.locator("#benchmark-status");
        // S1 已知同族缺陷:截图前必须把 UI 选择器同步到实测档位,否则证据图显示默认值。
        // 并行会话可能把共享 dist 回写成陈旧构建,这里用 DOM 注入保证选项存在,再设值。
        await page.evaluate(request => {
          const ensureOption = (selectId, value, label) => {
            const select = document.getElementById(selectId);
            if (!select) throw new Error(`Missing #${selectId} for evidence sync.`);
            if (![...select.options].some(option => option.value === value)) {
              const option = document.createElement("option");
              option.value = value; option.textContent = label;
              select.appendChild(option);
            }
            select.value = value;
          };
          ensureOption("asset", "FactoryWorkshop", "Kenney Factory Kit / 多资产车间 (8 类)");
          ensureOption("count", request.countLabel, request.countLabel);
          ensureOption("trajectory", "fixture.factory.workshop-tour-20s", "车间 20s 巡视(环绕+推拉+俯仰)");
        }, { countLabel: String(count) });
        // warm 相位结束时后端已释放(画布会回落到背景色);截图必须在渲染器存活的
        // renderAtPose 之内完成。t=0 与 t=10000 是轨迹两个代表性姿态(起点/推拉最近点)。
        await page.evaluate(async request => await globalThis.__t00WorkshopPose(request.count, request.timeMs),
          { count, timeMs: 0 });
        await status.evaluate((element, value) => { element.textContent = `T00 多资产车间 · ${value.toLocaleString()} 实例 · Deep WebGPU(warm 后轨迹 t=0 姿态)`; }, count);
        await page.screenshot({ path: `${base}-warm-t0000.png`, fullPage: true });
        await page.locator("#candidate-canvas").screenshot({ path: `${base}-warm-t0000-canvas.png` });
        tier.screenshots.warmFullPage = `${base}-warm-t0000.png`;
        tier.screenshots.warmCanvasT0000 = `${base}-warm-t0000-canvas.png`;
        const mid = await page.evaluate(async request => await globalThis.__t00WorkshopPose(request.count, request.timeMs),
          { count, timeMs: 10_000 });
        tier.trajectoryMidPose = mid;
        await status.evaluate((element, value) => { element.textContent = `T00 多资产车间 · ${value.toLocaleString()} 实例 · 轨迹中点 t=10s(推拉最近、最低俯仰)`; }, count);
        await page.locator("#candidate-canvas").screenshot({ path: `${base}-trajectory-t10000-canvas.png` });
        tier.screenshots.trajectoryCanvasT10000 = `${base}-trajectory-t10000-canvas.png`;
        await page.evaluate(() => globalThis.__t00WorkshopDispose());
      }
      await context.close();
    }
    result.tiers[count] = tier;
    console.log(`tier ${count}: rounds=${tier.rounds.length} fixtureSha256=${tier.fixtureSha256}`);
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ output, tiers: Object.keys(result.tiers), pageErrors: result.pageErrors.length }, null, 2));
} finally {
  await browser.close().catch(() => {});
  server.kill();
}
