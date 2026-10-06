// 启动性能基线探针(体量/性能极致批次):page.goto → canvas[data-renderer-backend] 出现
// = 启动墙钟;首帧后 performance.memory = JS 堆;deep-webgpu:* mark = 阶段归因。
// 纪律:headless 下 Dawn shader disk cache 被禁(见 probe-deep-firstframe-cache.mjs),
// 热缓存档必须 HEADLESS=0 有头跑。用法:
//   HEADLESS=0 node apps/web/scripts/probe-startup-baseline.mjs            # 冷+热(持久 profile 两轮)
//   node apps/web/scripts/probe-startup-baseline.mjs                       # headless 快测(仅冷档口径)
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const route = `/studio/${sceneId}?project=${projectId}`;
const output = process.env.STARTUP_OUTPUT_DIR
  ? `${process.env.STARTUP_OUTPUT_DIR.replace(/[\\/]$/u, "")}/`
  : fileURLToPath(new URL("../../../test-output/startup-baseline/", import.meta.url));
const backend = process.env.STARTUP_BACKEND ?? "webgpu"; // webgpu=Deep WebGPU;webgl=常规三维
await mkdir(output, { recursive: true });

const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const { token } = await login.json();
const launchOptions = {
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: process.env.HEADLESS !== "0",
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
};
const profileDir = process.env.PROBE_PROFILE;
const browser = profileDir
  ? await playwright.chromium.launchPersistentContext(profileDir, launchOptions)
  : await playwright.chromium.launch(launchOptions);
const context = profileDir ? browser : await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token, backend }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", backend);
}, { token, backend });
const page = await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });

const consoleErrors = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text().slice(0, 300)); });
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

const backendSelector = backend === "webgpu"
  ? '.viewport canvas[data-renderer-backend="deep-webgpu"]'
  : ".viewport canvas[data-renderer-backend]";
const started = Date.now();
await page.goto(`${webOrigin}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
const gotoDoneMs = Date.now() - started;
await page.locator(backendSelector).first().waitFor({ state: "visible", timeout: 120_000 });
const backendReadyMs = Date.now() - started;
// 等 mark 流收干(backend 后台链晚于 canvas 出现);再拍阶段与堆。
await page.waitForTimeout(4_000);
const sample = await page.evaluate(() => ({
  marks: performance.getEntriesByType("mark")
    .filter((entry) => entry.name.startsWith("deep-webgpu:"))
    .map((entry) => ({ name: entry.name, at: Number(entry.startTime.toFixed(1)) })),
  heap: performance.memory
    ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit }
    : null,
  resources: performance.getEntriesByType("resource")
    .map((entry) => ({ name: entry.name.split("/").pop().slice(0, 60), transferSize: entry.transferSize, duration: Number(entry.duration.toFixed(1)) }))
    .filter((entry) => entry.transferSize > 100_000)
    .sort((a, b) => b.transferSize - a.transferSize)
    .slice(0, 10),
}));
await browser.close();

const marks = sample.marks;
const stages = [];
for (let index = 1; index < marks.length; index += 1) {
  stages.push({ from: marks[index - 1].name.split(":")[1], to: marks[index].name.split(":")[1], deltaMs: Number((marks[index].at - marks[index - 1].at).toFixed(1)) });
}
const summary = {
  backend, headless: launchOptions.headless, gotoDoneMs, startupMs: backendReadyMs,
  heapMB: sample.heap ? Number((sample.heap.usedJSHeapSize / 1048576).toFixed(1)) : null,
  heapLimitMB: sample.heap ? Number((sample.heap.jsHeapSizeLimit / 1048576).toFixed(0)) : null,
  stages, topResources: sample.resources, consoleErrors: consoleErrors.slice(0, 8),
};
await writeFile(`${output}startup-${backend}-${launchOptions.headless ? "headless" : "headful"}-${Date.now()}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
