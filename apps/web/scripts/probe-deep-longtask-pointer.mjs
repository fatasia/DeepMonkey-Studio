// 临时归因探针(不提交):patch addEventListener(登记 pointermove 监听源码与
// 调用计数)+ patch requestAnimationFrame(记录回调源码与触发时间),与 hooks
// diff(#54=revision / #73=navigationDiagnostics)时间轴对齐,抓逐帧 setState 现行。
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
  window.__listeners = [];
  window.__listenerCalls = [];
  window.__rafCalls = [];
  const oAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, opts) {
    if ((type === "pointermove" || type === "pointerdown" || type === "pointerup") && typeof listener === "function") {
      const entry = { type, src: String(listener).replace(/\s+/g, " ").slice(0, 220), calls: 0, fn: listener };
      window.__listeners.push(entry);
      const wrapped = (ev) => {
        entry.calls += 1;
        if (window.__dragStart !== undefined && performance.now() >= window.__dragStart && window.__listenerCalls.length < 400) {
          window.__listenerCalls.push({ t: Math.round(performance.now()), type, src: entry.src.slice(0, 60) });
        }
        return entry.fn.call(this, ev);
      };
      return oAdd.call(this, type, wrapped, opts);
    }
    return oAdd.call(this, type, listener, opts);
  };
  const oRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    const key0 = String(cb);
    if (key0.includes("setRevision") && (!window.__revStacks || window.__revStacks.length < 8)) {
      (window.__revStacks = window.__revStacks || []).push({ t: Math.round(performance.now()), stack: new Error().stack?.split("\n").filter(s => s.trim()).slice(1, 15).join(" <- ").slice(0, 800) });
    }
    return oRaf((ts) => {
    if (window.__dragStart !== undefined && performance.now() >= window.__dragStart) {
      const key = String(cb).replace(/\s+/g, " ").slice(0, 80);
      const last = window.__rafCalls[window.__rafCalls.length - 1];
      if (!last || last.src !== key) window.__rafCalls.push({ t: Math.round(performance.now()), src: key, n: 1 });
      else last.n += 1;
    }
      return cb(ts);
    });
  };
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
await page.evaluate(() => { window.__dragStart = Math.round(performance.now()); });
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
await page.mouse.move(x, y); await page.mouse.down();
for (let i = 0; i < 120; i++) {
  const phase = i / 119 * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18, y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(200);
const report = await page.evaluate(() => ({
  dragStart: window.__dragStart,
  listeners: (window.__listeners || []).map(l => ({ type: l.type, calls: l.calls, src: l.src.slice(0, 160) })).filter(l => l.calls > 0),
  listenerCallCount: (window.__listenerCalls || []).length,
  rafCalls: (window.__rafCalls || []),
  revStacks: (window.__revStacks || []),
}));
console.log(JSON.stringify(report, null, 1));
await browser.close();
