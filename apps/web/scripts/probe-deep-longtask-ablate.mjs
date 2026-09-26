// 临时消融探针(不提交):登记全部 setInterval 回调源码;拖拽前由 Node 侧
// 按周期选择性 clearInterval,对比拖拽窗口长帧数 —— 直接验证"哪个定时器
// 的回调触发全壳重渲染"。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const webOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const CLEAR_DELAYS = (process.env.CLEAR_DELAYS ?? "").split(",").filter(Boolean).map(Number);
const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const { token } = await login.json();
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
  window.__timers = [];
  const oSetInterval = window.setInterval.bind(window);
  window.setInterval = (fn, d, ...rest) => {
    const id = oSetInterval(fn, d, ...rest);
    window.__timers.push({ id, d, src: String(fn).replace(/\s+/g, " ").slice(0, 200) });
    return id;
  };
  // WS 消息时间轴:sceneDataBridge 走 WebSocket,帧不进 page response 事件。
  window.__wsLog = [];
  const OWS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new OWS(...args);
    ws.addEventListener("message", (e) => {
      window.__wsLog.push({ t: Math.round(performance.now()), n: String(e.data ?? "").slice(0, 100) });
      if (window.__wsLog.length > 300) window.__wsLog.shift();
    });
    return ws;
  };
  Object.assign(window.WebSocket, { OPEN: OWS.OPEN, CLOSED: OWS.CLOSED, CLOSING: OWS.CLOSING, CONNECTING: OWS.CONNECTING, prototype: OWS.prototype });
}, { token });
const page = await context.newPage();
page.on("pageerror", e => console.error("[pageerror]", e.message.slice(0, 200)));
await page.goto(`${webOrigin}/studio/fedab835-389b-43a5-99be-6820d0f3afde?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible", timeout: 60000 });
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
// 拖拽前按周期清除定时器(消融组)
const cleared = await page.evaluate((delays) => {
  const out = [];
  for (const t of window.__timers) {
    if (delays.includes(t.d)) { window.clearInterval(t.id); out.push({ id: t.id, d: t.d, src: t.src.slice(0, 120) }); }
  }
  return out;
}, CLEAR_DELAYS);
await page.evaluate(() => {
  window.__laf = [];
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) window.__laf.push({ d: Math.round(e.duration), t: Math.round(e.startTime) });
  }).observe({ type: "long-animation-frame" });
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
await page.waitForTimeout(200);
const report = await page.evaluate(() => {
  const start = window.__dragStart - 50;
  return {
    dragStart: window.__dragStart,
    dragLongFrames: window.__laf.filter(f => f.t >= start),
    dragWs: (window.__wsLog || []).filter(w => w.t >= start),
    timers: window.__timers,
  };
});
console.log(JSON.stringify({
  clearedDelays: CLEAR_DELAYS,
  cleared,
  dragLongFrameCount: report.dragLongFrames.length,
  dragLongFrames: report.dragLongFrames,
  dragWsCount: report.dragWs.length,
  dragWs: report.dragWs.slice(0, 25),
  allTimers: report.timers,
}, null, 1));
await browser.close();
