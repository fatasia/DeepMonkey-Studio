// 首帧编译缓存(P0-2)双切验证:同一页面 webgl→webgpu→webgl→webgpu,
// 比对第二次切到 webgpu 的 scene-uploaded 阶段耗时(应接近 0,命中 packet 缓存)。
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const route = `/studio/${sceneId}?project=${projectId}`;
const output = process.env.FAIR_OUTPUT_DIR
  ? `${process.env.FAIR_OUTPUT_DIR.replace(/[\\/]$/u, "")}/`
  : fileURLToPath(new URL("../../../test-output/deep-firstframe-double-switch/", import.meta.url));
await mkdir(output, { recursive: true });

const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const { token } = await login.json();
const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
const page = await context.newPage();
await page.goto(`${webOrigin}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible", timeout: 60_000 });

async function marks() {
  return page.evaluate(() => performance.getEntriesByType("mark")
    .filter(entry => entry.name.startsWith("deep-webgpu:"))
    .map(entry => ({ name: entry.name, at: Number(entry.startTime.toFixed(1)) })));
}
async function switchTo(backend) {
  const preference = backend;
  const current = await page.evaluate(() => localStorage.getItem("bim-studio.renderer-backend"));
  if (current === preference) return;
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  if (!(await dialog.isVisible().catch(() => false))) {
    await page.getByLabel("更多场景工具", { exact: true }).click();
    await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  }
  await dialog.waitFor({ state: "visible" });
  const button = backend === "webgl" ? "切换到兼容模式" : "启用 Deep WebGPU Beta";
  await dialog.getByRole("button", { name: button, exact: true }).click();
  if (backend === "webgl") {
    await page.waitForFunction(() => {
      const authorCanvas = document.querySelector(".viewport canvas:not([data-renderer-backend])");
      return authorCanvas && getComputedStyle(authorCanvas).opacity === "1";
    }, undefined, { timeout: 120_000 });
  } else {
    await page.waitForFunction(expected => {
      const canvas = document.querySelector(`.viewport canvas[data-renderer-backend="${expected}"]`);
      const failed = document.querySelector(".renderer-switch-status.failed");
      return failed || (canvas && getComputedStyle(canvas).opacity === "1");
    }, "deep-webgpu", { timeout: 120_000 });
  }
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForTimeout(600);
}

const rounds = [];
for (let round = 1; round <= 2; round += 1) {
  await switchTo("webgl");
  await page.waitForTimeout(500);
  const before = (await marks()).length;
  const started = Date.now();
  await switchTo("webgpu");
  const wallMs = Date.now() - started;
  const all = await marks();
  const phases = all.slice(before);
  const stages = [];
  let prev = null;
  for (const phase of phases) {
    if (prev) stages.push({ from: prev.name.split(":")[1], to: phase.name.split(":")[1], deltaMs: Number((phase.at - prev.at).toFixed(1)) });
    prev = phase;
  }
  rounds.push({ round, wallMs, stages });
}
await browser.close();
const [first, second] = rounds;
const sceneFirst = first.stages.find(s => s.to === "scene-uploaded")?.deltaMs;
const sceneSecond = second.stages.find(s => s.to === "scene-uploaded")?.deltaMs;
const summary = { firstSwitch: first, secondSwitch: second,
  sceneUploadFirstMs: sceneFirst, sceneUploadSecondMs: sceneSecond,
  cacheEffective: sceneFirst !== undefined && sceneSecond !== undefined ? sceneSecond < sceneFirst * 0.5 : null };
await writeFile(`${output}report.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
