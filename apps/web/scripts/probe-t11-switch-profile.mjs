import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const output = path.resolve(repositoryRoot,
  process.env.T11_PROFILE_OUTPUT_DIR ?? "test-output/deep-core/T11/switch-profile-r1");
const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5199";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const profileCpu = process.env.T11_CPU_PROFILE !== "0";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
// T11 A/B 测量：T11_ROUTE_PARAMS 附加查询参数（如 "t11-critical-pipelines=0"），
// 用于在同一构建上单独关闭各时序开关。
const route = `/studio/${sceneId}?project=${projectId}${process.env.T11_ROUTE_PARAMS ? `&${process.env.T11_ROUTE_PARAMS}` : ""}`;
await mkdir(output, { recursive: true });
const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }) });
if (login.status !== 200) throw new Error(`Studio login failed: HTTP ${login.status}`);
const { token } = await login.json();
const browser = await playwright.chromium.launch({
  executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});
const guards = [];
let profile;
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(value => {
    localStorage.setItem("bim-studio-auth-token", value);
    localStorage.setItem("bim-studio.renderer-backend", "webgl");
  }, token);
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  page.on("pageerror", error => guards.push({ type: "pageerror", message: error.message }));
  page.on("response", response => {
    if (response.status() >= 500) guards.push({ type: "http5xx", status: response.status(), url: response.url() });
  });
  page.on("requestfailed", request => guards.push({ type: "requestfailed", url: request.url(),
    reason: request.failure()?.errorText }));
  await page.goto(`${webOrigin}${route}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible" });
  await page.waitForTimeout(1_500);
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  await page.getByLabel("更多场景工具", { exact: true }).click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  await dialog.waitFor({ state: "visible" });
  const cdp = profileCpu ? await context.newCDPSession(page) : undefined;
  if (cdp) { await cdp.send("Profiler.enable"); await cdp.send("Profiler.start"); }
  await dialog.getByRole("button", { name: "启用 Deep WebGPU Beta", exact: true }).click();
  await page.locator('.viewport canvas[data-renderer-backend="deep-webgpu"]').waitFor({ state: "attached" });
  await page.waitForFunction(() => {
    const canvas = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
    return document.querySelector(".renderer-switch-status.failed")
      || (canvas && getComputedStyle(canvas).opacity === "1");
  }, undefined, { timeout: 120_000 });
  const failed = page.locator(".renderer-switch-status.failed");
  if (await failed.count()) throw new Error(`WebGPU switch failed: ${await failed.textContent()}`);
  if (cdp) { profile = (await cdp.send("Profiler.stop")).profile; await cdp.send("Profiler.disable"); }
  const marks = await page.evaluate(() => performance.getEntriesByType("mark")
    .filter(entry => entry.name.startsWith("deep-webgpu:"))
    .map(entry => ({ name: entry.name, startTime: entry.startTime })));
  const start = marks.find(entry => entry.name === "deep-webgpu:switch-start")?.startTime ?? 0;
  const current = marks.filter(entry => entry.startTime >= start);
  const phases = current.slice(1).map((entry, index) => ({ from: current[index].name,
    to: entry.name, ms: +(entry.startTime - current[index].startTime).toFixed(3) }));
  const result = { schema: "t11-switch-profile-v1", route, profileCpu, marks: current,
    phases, topCpu: profile ? summarizeProfile(profile) : [], guards };
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
  if (profile) await writeFile(path.join(output, "cpu.cpuprofile"), JSON.stringify(profile));
  await page.locator('.viewport canvas[data-renderer-backend="deep-webgpu"]').screenshot({ path: path.join(output, "webgpu.png") });
  console.log(JSON.stringify({ output, guards, phases, topCpu: result.topCpu.slice(0, 12) }));
} finally {
  await browser.close();
}

function summarizeProfile(value) {
  const nodes = new Map(value.nodes.map(node => [node.id, node.callFrame]));
  const totals = new Map();
  for (let index = 0; index < value.samples.length; index++) {
    const frame = nodes.get(value.samples[index]);
    if (!frame) continue;
    const key = `${frame.functionName || "(anonymous)"} @ ${frame.url}:${frame.lineNumber + 1}`;
    totals.set(key, (totals.get(key) ?? 0) + (value.timeDeltas?.[index] ?? 0) / 1_000);
  }
  return [...totals].sort((a, b) => b[1] - a[1]).slice(0, 40)
    .map(([functionNameAndSource, selfMs]) => ({ functionNameAndSource, selfMs: +selfMs.toFixed(3) }));
}
