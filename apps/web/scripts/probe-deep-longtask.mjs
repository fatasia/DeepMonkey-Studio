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
await dialog.getByRole("button", { name: "启用 Deep WebGPU Beta", exact: true }).click();
await page.waitForFunction(() => {
  const c = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
  return c && getComputedStyle(c).opacity === "1";
}, undefined, { timeout: 120000 });
await dialog.getByRole("button", { name: "关闭", exact: true }).click();
await page.waitForTimeout(800);
const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
// 注入长任务归因
await page.evaluate(() => {
  const lt = [];
  new PerformanceObserver(list => { for (const e of list.getEntries()) lt.push({ d: Math.round(e.duration), t: Math.round(e.startTime), a: e.attribution?.[0]?.name ?? "?" }); }).observe({ type: "longtask", buffered: true });
  window.__lt = lt;
});
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
await page.mouse.move(x, y); await page.mouse.down();
for (let i = 0; i < 120; i++) {
  const phase = i / 119 * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18, y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up(); await page.waitForTimeout(150);
const report = await page.evaluate(() => ({
  longTasks: window.__lt,
  raf: (() => { return "n/a"; })(),
}));
console.log(JSON.stringify(report.longTasks, null, 1));
await browser.close();
