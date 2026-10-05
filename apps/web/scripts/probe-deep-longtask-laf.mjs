// 临时归因探针(不提交):用 long-animation-frame 的 scripts.attribution 拿拖拽期
// 长帧内每个脚本块的 invoker(定时器回调/消息监听/React MessageChannel 泵),
// 直接定位"谁在拖拽期 setState 触发全壳渲染"。
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
page.on("pageerror", e => console.error("[pageerror]", e.message));
const netLog = [];
page.on("response", (res) => {
  const url = res.url();
  if (url.includes("/editor") || url.includes("presence")) {
    netLog.push({ t: Math.round(performance.now()), s: res.status(), u: url.split("?")[0].replace(/^.*\//, "") });
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
  window.__laf = [];
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      window.__laf.push({
        d: Math.round(e.duration), t: Math.round(e.startTime),
        blocking: Math.round(e.blockingDuration),
        scripts: e.scripts.map(s => ({
          inv: String(s.invoker ?? "").slice(0, 80),
          invt: s.invokerType,
          src: (s.sourceURL || "").replace(/^.*[\\/]/, "") + ":" + s.sourceLine,
          d: Math.round(s.duration),
        })),
      });
    }
  }).observe({ type: "long-animation-frame", buffered: true });
  window.__dragStart = Math.round(performance.now());
});
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
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
  return { dragLongFrames: window.__laf.filter(f => f.t >= start) };
});
console.log(JSON.stringify({
  count: report.dragLongFrames.length,
  frames: report.dragLongFrames,
  dragNet: netLog,
}, null, 1));
await browser.close();
