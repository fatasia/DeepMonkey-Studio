// 临时消融探针(不提交):拖拽期网络请求日志 + React commit 时间轴,
// 用于定位"全壳重渲染"的 state 触发源(driver 轮询事务 / WS / 其他)。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const webOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const { token } = await login.json();
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
// React commit 计数:devtools hook 在 React 加载前注入,onCommitFiberRoot 每次提交记一笔。
await context.addInitScript(() => {
  window.__commits = [];
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    supportsFlight: true,
    supportsProfiling: true,
    inject(internals) { this._renderer = internals; return 1; },
    onCommitFiberRoot() { window.__commits.push(Math.round(performance.now())); },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
  };
});
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
const page = await context.newPage();
// 网络:只记 editor presence/driver/snapshot 与 workspace 相关轮询
const netLog = [];
page.on("response", (res) => {
  const url = res.url();
  if (url.includes("editor") || url.includes("presence") || url.includes("workspace") || url.includes("project")) {
    netLog.push({ t: Math.round(performance.now()), s: res.status(), u: url.replace(webOrigin, "").split("?")[0].slice(-70) });
  }
});
await page.goto(`${webOrigin}/studio/fedab835-389b-43a5-99be-6820d0f3afde?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible", timeout: 60000 });
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
await page.evaluate(() => {
  const lt = [];
  new PerformanceObserver(list => { for (const e of list.getEntries()) lt.push({ d: Math.round(e.duration), t: Math.round(e.startTime) }); }).observe({ type: "longtask" });
  window.__lt = lt;
  window.__lt.length = 0;
});
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
await page.evaluate(() => { window.__dragStart = Math.round(performance.now()); window.__commitBase = window.__commits.length; });
await page.mouse.move(x, y); await page.mouse.down();
for (let i = 0; i < 120; i++) {
  const phase = i / 119 * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18, y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(150);
const report = await page.evaluate(() => {
  const start = window.__dragStart - 50;
  const end = Math.round(performance.now());
  return {
    dragWindow: { start, end },
    dragLongTasks: window.__lt.filter(t => t.t >= start),
    dragCommits: window.__commits.filter(t => t >= start).length,
    totalCommits: window.__commits.length,
  };
});
const dragNet = netLog.filter(n => n.t >= report.dragWindow.start);
console.log(JSON.stringify({
  dragLongTaskCount: report.dragLongTasks.length,
  dragLongTasks: report.dragLongTasks,
  dragCommitCount: report.dragCommits,
  dragCommitTimes: report.dragCommits <= 40 ? undefined : undefined,
  dragNetCount: dragNet.length,
  dragNet: dragNet,
}, null, 1));
await browser.close();
