import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const webOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const { token } = await login.json();
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
const page = await context.newPage();
await page.goto(`${webOrigin}/studio/fedab835-389b-43a5-99be-6820d0f3afde?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible", timeout: 60000 });
// 切 webgpu
const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
await page.getByLabel("更多场景工具", { exact: true }).click();
await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
await dialog.getByRole("button", { name: "启用 Deep WebGPU", exact: true }).click();
await page.waitForFunction(() => {
  const c = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
  return c && getComputedStyle(c).opacity === "1";
}, undefined, { timeout: 120000 });
await dialog.getByRole("button", { name: "关闭", exact: true }).click();
await page.waitForTimeout(800);
const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
// 注入长任务归因:全会话累积 + 拖拽窗口标记。buffered 会把切换阶段(React 挂载、
// 首渲、上传)的长任务一并送进来,不做窗口过滤时它们会被误记成"拖拽期长帧"。
await page.evaluate(() => {
  const lt = [];
  new PerformanceObserver(list => { for (const e of list.getEntries()) lt.push({ d: Math.round(e.duration), t: Math.round(e.startTime), a: e.attribution?.[0]?.name ?? "?" }); }).observe({ type: "longtask", buffered: true });
  window.__lt = lt;
  window.__marks = [];
});
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
await page.evaluate(() => { window.__marks.push({ dragStart: Math.round(performance.now()) }); });
await page.mouse.move(x, y); await page.mouse.down();
for (let i = 0; i < 120; i++) {
  const phase = i / 119 * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18, y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.evaluate(() => { window.__marks.push({ dragEnd: Math.round(performance.now()) }); });
await page.waitForTimeout(150);
const report = await page.evaluate(() => {
  const [start, end] = window.__marks;
  const inWindow = window.__lt.filter(task => task.t >= start.dragStart - 50 && task.t <= end.dragEnd + 150);
  return { window: { dragStart: start.dragStart, dragEnd: end.dragEnd },
    dragLongTasks: inWindow, allLongTasks: window.__lt,
    raf: (() => { return "n/a"; })() };
});
// 输出:拖拽窗口长任务(输入路径的真实目标)+ 全会话任务数摘要。
const summary = {
  dragWindow: report.window,
  dragLongTaskCount: report.dragLongTasks.length,
  dragLongTasks: report.dragLongTasks,
  allSessionLongTaskCount: report.allLongTasks.length,
  allSessionLongTasks: report.allLongTasks,
};
console.log(JSON.stringify(summary, null, 1));
await browser.close();
