// 全会话 CDP 时间线归因 v3(临时,不提交):从页面加载开始 trace,四个标记
// (PAGE_LOADED/SWITCH_DONE/DRAG_START/DRAG_END)对齐时钟;输出每个长任务的
// GC/顶层 JS 归因与全会话大 GC 事件分布,区分"切换阶段压力"与"拖拽阶段压力"。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const webOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const KEEP = new Set(["MinorGC", "MajorGC", "GCEvent", "FunctionCall", "FireAnimationFrame", "EventDispatch",
  "TimerFire", "TimeStamp", "EvaluateScript", "Layout", "UpdateLayoutTree", "Paint", "PrePaint", "RasterTask",
  "Commit", "RunMicrotasks", "HitTest"]);
const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const { token } = await login.json();
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
// 拖拽期 DOM 变更采样:定位拖拽期 setState 的 UI 区域(MutationObserver,零 React 侵入)。
await context.addInitScript(() => {
  window.__mutLog = [];
  window.__startMutLog = () => {
    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        const el = m.target instanceof Element ? m.target : m.target.parentElement;
        if (!el) continue;
        const cls = typeof el.className === "string" ? el.className.split(" ").slice(0, 3).join(".") : "";
        window.__mutLog.push({ t: Math.round(performance.now()), node: (el.tagName + (cls ? "." + cls : "")).slice(0, 90) });
        if (window.__mutLog.length > 400) return;
      }
    });
    obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    window.__stopMutLog = () => obs.disconnect();
  };
});

const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const timeline = [];
cdp.on("Tracing.dataCollected", m => { for (const e of m.value) if (KEEP.has(e.name)) timeline.push(e); });
await cdp.send("Tracing.start", { traceConfig: { includedCategories: ["devtools.timeline"] } });
await page.goto(`${webOrigin}/studio/fedab835-389b-43a5-99be-6820d0f3afde?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.evaluate(() => { console.timeStamp("PAGE_LOADED"); window.__m0 = Math.round(performance.now()); return window.__m0; });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible", timeout: 180000 });
let switchDone = 0;
if (!process.env.WEBGL) {
const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
await page.getByLabel("更多场景工具", { exact: true }).click();
await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
await dialog.getByRole("button", { name: "启用 Deep WebGPU", exact: true }).click();
await page.waitForFunction(() => {
  const c = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
  return c && getComputedStyle(c).opacity === "1";
}, undefined, { timeout: 120000 });
await page.evaluate(() => { console.timeStamp("SWITCH_DONE"); window.__m1 = Math.round(performance.now()); });
switchDone = await page.evaluate(() => window.__m1);
await dialog.getByRole("button", { name: "关闭", exact: true }).click();
await page.waitForTimeout(800);
} else {
  await page.waitForTimeout(1500);
}
const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
await page.evaluate(() => {
  const lt = [];
  new PerformanceObserver(list => { for (const e of list.getEntries()) lt.push({ d: Math.round(e.duration), t: Math.round(e.startTime) }); }).observe({ type: "longtask", buffered: true });
  const heap = [];
  const heapTimer = setInterval(() => {
    heap.push({ t: Math.round(performance.now()), mb: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) });
    if (heap.length > 1200) heap.shift();
  }, 100);
  window.__lt = lt; window.__heap = heap; window.__heapTimer = heapTimer;
  // React 渲染栈采样器:拖拽期每 5ms 抓一次 Error.stack,只保留 React 调度帧,
  // 用于定位拖拽期重渲染的组件(setState 来源)。
  window.__reactStacks = [];
  window.__startStackSampler = () => {
    let total = 0; window.__sampleTotal = () => total;
    const sampler = setInterval(() => {
      total++;
      const stack = new Error().stack;
      if (total % 40 === 1) window.__reactStacks.push({ t: Math.round(performance.now()), stack: "RAW:" + (stack ?? "null").slice(0, 600) });
      if (stack && /performWorkUntilDeadline|renderRootSync|flushSyncWork|dispatchDiscreteEvent|commitRoot/.test(stack)) {
        window.__reactStacks.push({ t: Math.round(performance.now()), stack });
      }
    }, 5);
    window.__stopStackSampler = () => clearInterval(sampler);
  };
});
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
await cdp.send("Profiler.start");
await page.evaluate(() => { console.timeStamp("DRAG_START"); window.__m2 = Math.round(performance.now()); window.__startStackSampler(); });
const dragStart = await page.evaluate(() => window.__m2);
await page.mouse.move(x, y); await page.mouse.down();
for (let i = 0; i < 120; i++) {
  const phase = i / 119 * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18, y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.evaluate(() => { console.timeStamp("DRAG_END"); window.__m3 = Math.round(performance.now()); window.__fiberWalk = false; });
const dragEnd = await page.evaluate(() => window.__m3);
await page.waitForTimeout(300);
const profile = (await cdp.send("Profiler.stop")).profile;
const longTasks = await page.evaluate(() => { clearInterval(window.__heapTimer); return window.__lt; });
const commits = await page.evaluate(() => window.__commits);
const mutLog = await page.evaluate(() => window.__mutLog ?? []);
const reactStacks = await page.evaluate(() => (window.__reactStacks ?? []).map(s => s.stack));
const heap = await page.evaluate(() => window.__heap);
// CPU profile:performWorkUntilDeadline 子树的命中分布 = 拖拽期 React 渲染时间去向。
const nodesById = new Map(profile.nodes.map(n => [n.id, n]));
const childrenOf = new Map(profile.nodes.map(n => [n.id, n.children ?? []]));
const parentOf = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
const reactRoots = profile.nodes.filter(n => n.callFrame.functionName === "performWorkUntilDeadline");
const subtreeHits = new Map();
const countSubtree = (id) => {
  if (subtreeHits.has(id)) return subtreeHits.get(id);
  let total = (nodesById.get(id)?.hitCount ?? 0);
  for (const c of childrenOf.get(id) ?? []) total += countSubtree(c);
  subtreeHits.set(id, total);
  return total;
};
const reactTotal = reactRoots.reduce((acc, r) => acc + countSubtree(r.id), 0);
const reactAppFrames = new Map();
const walk = (id, depth) => {
  if (depth > 200) return;
  for (const c of childrenOf.get(id) ?? []) {
    const frame = nodesById.get(c)?.callFrame;
    const url = String(frame?.url ?? "");
    if (frame?.functionName && url && !/node_modules/.test(url) && url.includes("src/")) {
      const key = `${frame.functionName}@${url.split("/").pop()}`;
      reactAppFrames.set(key, (reactAppFrames.get(key) ?? 0) + (nodesById.get(c)?.hitCount ?? 0));
    }
    walk(c, depth + 1);
  }
};
for (const r of reactRoots) walk(r.id, 0);
const hitMs = hits => Math.round(hits * 0.2);
const reactProfile = { totalMs: hitMs(reactTotal),
  appFrames: [...reactAppFrames.entries()].filter(([, h]) => h > 0).sort((a, b) => b[1] - a[1]).slice(0, 15)
    .map(([k, h]) => `${k}:${hitMs(h)}ms`) };
// setState 归因:从重渲染节点(renderRootSync 等)沿父链回溯到最近的 app 层
// 调用帧——同步渲染由离散事件/调度任务的发起方触发,父链顶端即 setState 源。
const setStateByCaller = new Map();
for (const n of profile.nodes) {
  if (!/renderRootSync|flushSyncWork|performWorkOnRootViaSchedulerTask|renderRootConcurrent/.test(n.callFrame.functionName ?? "")) continue;
  if (!n.hitCount) continue;
  let cur = n.id, hops = 0, appFrame = "(root)";
  while (parentOf.has(cur) && hops < 500) {
    cur = parentOf.get(cur);
    hops++;
    const frame = nodesById.get(cur)?.callFrame;
    const url = String(frame?.url ?? "");
    if (frame?.functionName && url.includes("src/") && !/node_modules/.test(url)) { appFrame = `${frame.functionName}@${url.split("/").pop()}`; break; }
  }
  setStateByCaller.set(appFrame, (setStateByCaller.get(appFrame) ?? 0) + n.hitCount);
}
const subtreeTop = new Map();
{
  const totals = new Map();
  const calc = (id) => { if (totals.has(id)) return totals.get(id); let t = (nodesById.get(id)?.hitCount ?? 0); for (const c of childrenOf.get(id) ?? []) t += calc(c); totals.set(id, t); return t; };
  for (const r of reactRoots) for (const c of childrenOf.get(r.id) ?? []) calc(c);
  for (const [id, t] of totals) { const f = nodesById.get(id)?.callFrame; if (f?.functionName) { const key = f.functionName + "@" + String(f.url ?? "").split("/").pop(); subtreeTop.set(key, Math.max(subtreeTop.get(key) ?? 0, t)); } }
}
const subtreeTopFrames = [...subtreeTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18).map(pair => pair[0] + ":" + hitMs(pair[1]) + "ms");
const setStateProfile = [...setStateByCaller.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([k, h]) => `${k}:${hitMs(h)}ms`);
const reactSampleFrames = (() => {
  const counts = new Map();
  for (const stack of reactStacks) {
    const frames = stack.split("\n").map(line => {
      const at = line.indexOf("at ");
      return at < 0 ? null : line.slice(at + 3).replace(/\?t=\d+/g, "").trim();
    }).filter(Boolean);
    const appFrames = frames.filter(f => /\.tsx|\.ts/.test(f) && !/node_modules|react-dom|scheduler/.test(f));
    for (const f of appFrames.slice(0, 3)) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(pair => pair[0] + " x" + pair[1]);
})();
await cdp.send("Tracing.end");
await new Promise(resolve => cdp.once("Tracing.tracingComplete", resolve));
const stamps = timeline.filter(e => e.name === "TimeStamp").map(e => ({ label: e.args?.data?.name, ts: e.ts }));
const evs = timeline.map(e => ({ name: e.name, ts: e.ts, dur: e.dur ?? 0, data: e.args?.data ?? {} }));
const loadStamp = stamps.find(s => s.label === "PAGE_LOADED");
const analyze = (label) => {
  if (!loadStamp) return { label, note: "no-alignment" };
  const marks = { PAGE_LOADED: stamps.find(s => s.label === "PAGE_LOADED"), SWITCH_DONE: stamps.find(s => s.label === "SWITCH_DONE"),
    DRAG_START: stamps.find(s => s.label === "DRAG_START"), DRAG_END: stamps.find(s => s.label === "DRAG_END") };
  return marks;
};
// 对齐:用 DRAG_START 的 pageMs(已知)与其 trace ts 推 offset。
const dragStartStamp = stamps.find(s => s.label === "DRAG_START");
const offsetUs = dragStartStamp ? dragStartStamp.ts - dragStart * 1000 : null;
const toPageMs = ts => offsetUs === null ? null : Math.round((ts - offsetUs) / 1000);
const analyzed = longTasks.map(task => {
  if (offsetUs === null) return { ...task, note: "no-alignment" };
  const from = (task.t - 5) * 1000 + offsetUs, to = (task.t + task.d + 5) * 1000 + offsetUs;
  const inside = evs.filter(e => e.ts + e.dur >= from && e.ts <= to && e.name !== "TimeStamp");
  const gc = inside.filter(e => /GC/.test(e.name)).map(e => `${e.name}:${Math.round(e.dur / 1000)}ms`);
  const js = inside.filter(e => e.name === "FunctionCall")
    .sort((a, b) => b.dur - a.dur).slice(0, 12)
    .map(e => `${e.data.functionName ?? "?"}@${String(e.data.url ?? "").split("/").pop() ?? ""}:${Math.round(e.dur / 1000)}ms`);
  const phase = task.t < switchDone ? "load/switch" : task.t < dragStart ? "pre-drag" : task.t <= dragEnd + 200 ? "drag" : "post-drag";
  return { ...task, phase, gc, topJs: js,
    counts: inside.reduce((acc, e) => { acc[e.name] = (acc[e.name] ?? 0) + 1; return acc; }, {}) };
});
const bigGc = evs.filter(e => /GC/.test(e.name) && e.dur > 5000).map(e => ({ name: e.name, pageMs: toPageMs(e.ts), ms: Math.round(e.dur / 1000) }));
const heapMinMax = { minMb: Math.min(...heap.map(h => h.mb)), maxMb: Math.max(...heap.map(h => h.mb)) };
const reactSampleCount = reactStacks.length;
console.log(JSON.stringify({ marks: { switchDone, dragStart, dragEnd }, aligned: offsetUs !== null,
  longTaskCount: longTasks.length, analyzed, bigGc, heapMinMax, reactProfile, setStateProfile, subtreeTopFrames, commits, mutLog, reactSampleFrames, reactSampleCount }, null, 1));
await browser.close();
