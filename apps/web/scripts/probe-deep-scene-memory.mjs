import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const cycles = Number(process.env.SCENE_MEMORY_CYCLES ?? 20);
assert.ok(Number.isSafeInteger(cycles) && cycles >= 4, "SCENE_MEMORY_CYCLES must be >= 4");
const output = process.env.SCENE_MEMORY_OUTPUT
  ?? fileURLToPath(new URL("../../../test-output/deep-core/T11/scene-memory.json", import.meta.url));
await mkdir(dirname(output), { recursive: true });

const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
assert.equal(login.status, 200, `Studio login failed: HTTP ${login.status}`);
const { token } = await login.json();
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
const report = { schema: "deep-monkey.scene-memory.v1", createdAt: new Date().toISOString(), cycles,
  route: `/studio/${sceneId}?project=${projectId}`, samples: [], guards: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(value => {
    localStorage.setItem("bim-studio-auth-token", value);
    localStorage.setItem("bim-studio.renderer-backend", "webgl");
  }, token);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const sample = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    const metric = name => metrics.find(value => value.name === name)?.value ?? null;
    return { heapUsedMb: metric("JSHeapUsedSize") === null ? null : metric("JSHeapUsedSize") / 1024 / 1024,
      domNodes: metric("Nodes"), jsEventListeners: metric("JSEventListeners") };
  };
  page.on("pageerror", error => report.guards.push({ type: "pageerror", text: error.message }));
  page.on("response", response => { if (response.status() >= 500)
    report.guards.push({ type: "http5xx", status: response.status(), url: response.url() }); });
  for (let cycle = 1; cycle <= cycles; cycle++) {
    await page.goto(`${webOrigin}${report.route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".viewport canvas:not([data-renderer-backend])").first()
      .waitFor({ state: "visible", timeout: 60_000 });
    await page.getByLabel("更多场景工具", { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
    await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
    await dialog.getByRole("button", { name: "启用 Deep WebGPU Beta", exact: true }).click();
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
      return canvas && getComputedStyle(canvas).opacity === "1";
    }, undefined, { timeout: 120_000 });
    await page.waitForTimeout(500);
    const entered = await sample();
    await page.goto(webOrigin, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(500);
    const exited = await sample();
    report.samples.push({ cycle, entered, exited });
    console.log(`cycle ${cycle}/${cycles}: entered=${entered.heapUsedMb?.toFixed(2) ?? "n/a"} MB, exited=${exited.heapUsedMb?.toFixed(2) ?? "n/a"} MB`);
  }
  const steady = report.samples.slice(3).map(value => value.exited.heapUsedMb);
  const available = steady.length && steady.every(value => Number.isFinite(value));
  const netPercent = available ? (steady.at(-1) - steady[0]) / steady[0] * 100 : null;
  const monotonic = available && steady.at(-1) > steady[0]
    && steady.every((value, index) => index === 0 || value >= steady[index - 1]);
  report.summary = { metric: "post-GC renderer JS heap after scene exit", warmupCycles: 3,
    startMb: available ? steady[0] : null, endMb: available ? steady.at(-1) : null,
    netPercent, monotonicGrowth: available ? monotonic : null,
    meetsFivePercent: available ? netPercent <= 5 && !monotonic : null,
    gpuMemory: "unmeasured" };
} catch (error) {
  report.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  await browser.close();
  await writeFile(output, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report.summary ?? { failure: report.failure }, null, 2));
if (report.failure || report.guards.length) process.exitCode = 1;
