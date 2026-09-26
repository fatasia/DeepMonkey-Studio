// 临时归因探针(不提交):React commit 时间轴(DevTools hook)+ hooks 链 diff,
// 定位拖拽期"哪条 useState 在每帧变"。fiber 遍历只在探针内,不影响产品代码。
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
  // 最小 DevTools hook:react-dom dev 每次提交回调一次;renderers 由 inject 维护
  // (react-refresh preamble 会 hook.renderers.forEach)。commit 时找 App fiber,
  // 对比 hooks 链快照,记录"哪条 hook state 变了"。
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(internals) { const id = this.renderers.size + 1; this.renderers.set(id, internals); return id; },
    onCommitFiberRoot(rendererID, root) {
      const t = Math.round(performance.now());
      try {
        const findApp = (f, depth) => {
          while (f) {
            if (typeof f.type === "function" && (f.type.name === "App" || f.type.displayName === "App")) return f;
            if (f.child && depth < 9) { const hit = findApp(f.child, depth + 1); if (hit) return hit; }
            f = f.sibling;
          }
          return undefined;
        };
        const app = findApp(root.current, 0);
        if (app) {
          const values = [];
          let hook = app.memoizedState;
          let i = 0;
          while (hook && i < 700) { values.push(hook.memoizedState); hook = hook.next; i++; }
          const prev = window.__appHooks;
          if (prev) {
            const changes = [];
            for (let j = 0; j < Math.min(prev.length, values.length); j++) {
              if (prev[j] !== values[j]) {
                const desc = (v) => { try { return typeof v === "object" ? (v === null ? "null" : Array.isArray(v) ? "arr(" + v.length + ")" : "obj") : String(v).slice(0, 60); } catch { return "?"; } };
                const v2 = values[j]; detail = " [" + (typeof v2 === "number" ? String(v2) : v2 === null ? "null" : Array.isArray(v2) ? "Array(" + v2.length + ")" : typeof v2 === "object" ? ((v2.constructor && v2.constructor.name) || "obj") + "{keys:" + Object.keys(v2).slice(0, 8).join(",") + "}" : String(v2)) + "]";changes.push("#" + j + ": " + desc(prev[j]) + " -> " + desc(values[j]) + detail);
                if (changes.length >= 6) break;
              }
            }
            if (changes.length) (window.__hookChanges = window.__hookChanges || []).push({ t, changes });
          } else {
            // 首次快照:记录链长与抽样值,自证对齐 useAppState 声明顺序。
            const desc = (v) => { try { return typeof v === "object" ? (v === null ? "null" : Array.isArray(v) ? "arr(" + v.length + ")" : "obj{" + Object.keys(v ?? {}).slice(0, 4).join(",") + "}") : String(v).slice(0, 40); } catch { return "?"; } };
            (window.__hookChanges = window.__hookChanges || []).push({ t, changes: ["SNAPSHOT len=" + values.length, ...values.slice(45, 166).map((v, idx) => "#" + (idx + 45) + "=" + desc(v))] });
          }
          window.__appHooks = values;
        }
      } catch { /* fiber 遍历失败不影响探针主流程 */ }
      (window.__commits = window.__commits || []).push(t);
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
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
await page.evaluate(() => {
  window.__laf = [];
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) window.__laf.push({ d: Math.round(e.duration), t: Math.round(e.startTime) });
  }).observe({ type: "long-animation-frame" });
  window.__dragStart = Math.round(performance.now());
  window.__appHooks = undefined;
  window.__hookChanges = [];
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
  const commits = (window.__commits || []).filter(t => t >= start);
  return {
    dragStart: window.__dragStart,
    dragLongFrames: window.__laf.filter(f => f.t >= start),
    dragCommitCount: commits.length,
    totalCommits: (window.__commits || []).length,
    hookChanges: (window.__hookChanges || []).filter(c => c.t >= start),
  };
});
console.log(JSON.stringify({
  dragLongFrameCount: report.dragLongFrames.length,
  dragCommitCount: report.dragCommitCount,
  hookChangeCount: report.hookChanges.length,
  hookChanges: report.hookChanges.slice(0, 24),
}, null, 1));
await browser.close();
