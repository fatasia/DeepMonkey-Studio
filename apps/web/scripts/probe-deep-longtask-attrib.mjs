// 长任务归因探针(临时,不提交):只包装 GPUDevice 的管线/shader 创建(稀有路径,
// 零热路径开销),记录拖拽窗口,窗口内归因长任务:有管线创建事件 → Dawn 编译;
// 无事件且堆曲线出现大幅下降 → GC;两者皆无 → 其他。
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
  const events = [];
  const p = GPUDevice.prototype;
  for (const name of ["createShaderModule", "createRenderPipeline", "createRenderPipelineAsync",
    "createComputePipeline", "createComputePipelineAsync"]) {
    const original = p[name];
    p[name] = function (...args) {
      events.push({ op: name, label: String(args?.[0]?.label ?? "").slice(0, 70), t: Math.round(performance.now()) });
      return original.apply(this, args);
    };
  }
  const lt = [];
  new PerformanceObserver(list => { for (const e of list.getEntries()) lt.push({ d: Math.round(e.duration), t: Math.round(e.startTime) }); }).observe({ type: "longtask", buffered: true });
  const heap = [];
  const heapTimer = setInterval(() => {
    heap.push({ t: Math.round(performance.now()), used: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) });
    if (heap.length > 600) heap.shift();
  }, 50);
  window.__attrib = { events, lt, heap, heapTimer, marks: [] };
});
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
await page.evaluate(() => { window.__attrib.marks.push({ dragStart: Math.round(performance.now()) }); });
await page.mouse.move(x, y); await page.mouse.down();
for (let i = 0; i < 120; i++) {
  const phase = i / 119 * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18, y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.evaluate(() => { window.__attrib.marks.push({ dragEnd: Math.round(performance.now()) }); });
await page.waitForTimeout(150);
const report = await page.evaluate(() => {
  const { events, lt, heap, heapTimer, marks } = window.__attrib;
  clearInterval(heapTimer);
  const start = marks[0].dragStart, end = marks[1].dragEnd;
  const tasks = lt.filter(task => task.t + task.d >= start && task.t <= end + 100);
  const attributed = tasks.map(task => {
    const inside = events.filter(e => e.t >= task.t - 8 && e.t <= task.t + task.d);
    const drop = (() => {
      let worst = 0;
      for (let i = 1; i < heap.length; i++) {
        if (heap[i].t < task.t - 40 || heap[i].t > task.t + task.d + 40) continue;
        worst = Math.min(worst, heap[i].used - heap[i - 1].used);
      }
      return worst;
    })();
    return { ...task, pipelines: inside.length ? inside : "none", heapDeltaMb: Math.round(-drop * 10) / 10 };
  });
  const totalDrop = (() => {
    let worst = 0;
    for (let i = 1; i < heap.length; i++) worst = Math.min(worst, heap[i].used - heap[i - 1].used);
    return Math.round(-worst * 10) / 10;
  })();
  return { window: { start, end }, taskCountInWindow: tasks.length, attributed,
    pipelineEventsTotal: events.length, pipelineEventsInWindow:
      events.filter(e => e.t >= start - 8 && e.t <= end + 100).length, maxHeapDropMb: totalDrop };
});
console.log(JSON.stringify(report, null, 1));
await browser.close();
