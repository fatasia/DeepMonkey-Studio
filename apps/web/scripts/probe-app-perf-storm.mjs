// 编辑器交互风暴归因探针:Long Task / React commit(含组件采样) / GC / CPU 自采样。
// 用法:node apps/web/scripts/probe-app-perf-storm.mjs [outDir](默认 test-output/app-perf-storm)
// 相序:create ×6 → orbit(有对象未选中) → property-drag → panels ×12 → undo ×10 → orbit-after → select-orbit。
// 每次运行经 API 克隆一个空场景副本,保证 A/B 同一确定性起点。
// 2026-10-06 基线/修复对比数据见 test-output/app-perf-storm-*/storm-report.json。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const webOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const outDir = resolve(process.argv[2] ?? "test-output/app-perf-storm-baseline");
mkdirSync(outDir, { recursive: true });

const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const { token } = await login.json();
const authHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const projectId = "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
// 克隆现有应用文档为空场景副本,保证每次运行同一确定性起点(0 对象)
const sourceApp = (await (await fetch(`${apiOrigin}/api/projects/${projectId}/applications/fedab835-389b-43a5-99be-6820d0f3afde`, { headers: authHeaders })).json());
const stormId = `perf-storm-${Date.now()}`;
const sceneId = `storm-scene-${Date.now()}`;
const emptyScene = {
  id: sceneId, name: "风暴场景",
  camera: { position: { x: 12, y: 8, z: 12 }, target: { x: 0, y: 1, z: 0 }, mode: "orbit" },
  models: [], primitives: [], measurements: [], annotations: [], weather: "sunny",
  lighting: sourceApp.scenes[0]?.lighting, environment: sourceApp.scenes[0]?.environment,
  postProcessing: sourceApp.scenes[0]?.postProcessing, physics: sourceApp.scenes[0]?.physics,
  animation: sourceApp.scenes[0]?.animation, dataBindings: [], cameraViews: [],
};
const docPayload = { ...sourceApp, metadata: { ...sourceApp.metadata, id: stormId, name: `性能风暴 ${new Date().toISOString().slice(11, 19)}`, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, scenes: [emptyScene] };
const appResp = await fetch(`${apiOrigin}/api/projects/${projectId}/applications`, {
  method: "POST", headers: authHeaders, body: JSON.stringify(docPayload),
});
if (!appResp.ok) { console.error("建场景失败:", appResp.status, await appResp.text()); process.exit(1); }
const application = await appResp.json();
console.log("[probe] 隔离场景:", application.metadata.id, sceneId);

const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  const commits = [];
  window.__stormCommits = commits;
  window.__stormPhase = "";
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map() };
  hook.inject = (renderer) => { hook.renderers.set(renderer.id, renderer); return renderer.id; };
  let commitIndex = 0;
  const sampleRendered = (fiber) => {
    // 有界 DFS:收集「本次提交里有实际 alternate 差异」的函数组件名(每 10 次提交采样一次)
    const out = [];
    const stack = [fiber];
    let seen = 0;
    while (stack.length && seen < 400 && out.length < 24) {
      const f = stack.pop();
      seen += 1;
      if (!f) continue;
      if (f.tag === 0 || f.tag === 1) {
        const name = f.type?.displayName || f.type?.name || "";
        if (name && f.alternate && f.alternate.memoizedProps !== f.memoizedProps) out.push(name);
      }
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return out;
  };
  hook.onCommitFiberRoot = (rendererId, root) => {
    commitIndex += 1;
    let sampled = undefined;
    if (commitIndex % 3 === 1) { try { sampled = sampleRendered(root.current); } catch { /* fiber 不可读时静默 */ } }
    commits.push({ phase: window.__stormPhase, t: Math.round(performance.now() * 10) / 10, sampled });
  };
  hook.onCommitFiberUnmount = () => {};
  const lt = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) lt.push({ phase: window.__stormPhase, d: Math.round(e.duration), t: Math.round(e.startTime) });
  }).observe({ type: "longtask", buffered: true });
  window.__stormLongTasks = lt;
  const heap = [];
  window.__stormHeapTimer = setInterval(() => {
    heap.push({ phase: window.__stormPhase, t: Math.round(performance.now()), used: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) });
    if (heap.length > 4000) heap.shift();
  }, 50);
  window.__stormHeap = heap;
}, { token });

const page = await context.newPage();
page.setDefaultTimeout(30_000);
const consoleLogs = [];
page.on("console", (m) => { if (["debug", "info", "warning", "error"].includes(m.type())) consoleLogs.push({ type: m.type(), text: m.text().slice(0, 160) }); });
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });

await page.goto(`${webOrigin}/studio/${projectId}/applications/${application.metadata.id}/scenes/${sceneId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible", timeout: 90000 });
await page.waitForTimeout(2500);
const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
const cx = bounds.x + bounds.width / 2, cy = bounds.y + bounds.height / 2;

const setPhase = (name) => page.evaluate((n) => { window.__stormPhase = n; }, name);
const phases = [];
async function runPhase(name, fn) {
  await setPhase(name);
  await cdp.send("Profiler.start");
  const t0 = Date.now();
  await fn();
  const wallMs = Date.now() - t0;
  const { profile } = await cdp.send("Profiler.stop");
  phases.push({ name, wallMs, profile });
  await setPhase("");
  await page.waitForTimeout(400);
}
const openDockMenu = async (label) => {
  await page.getByRole("button", { name: label, exact: true }).first().click();
};
const orbitDrag = async () => {
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 0; i < 90; i += 1) {
    const p = i / 89 * Math.PI * 4;
    await page.mouse.move(cx + Math.sin(p) * bounds.width * 0.2, cy + Math.cos(p * 0.5) * bounds.height * 0.1);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
};

// 相 2:创建 ×6
await runPhase("create", async () => {
  for (let i = 0; i < 6; i += 1) {
    await openDockMenu("创建");
    await page.getByRole("menuitem", { name: "球体", exact: true }).click();
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(120);
  }
});

// 相 2:轨道拖拽(有对象未选中)(无前置交互,对照对抗轮"干净会话 0 提交")
await runPhase("orbit-clean", orbitDrag);

// 相 3:属性滑块拖动(创建后对象已选中,直接找检查器 range)
await runPhase("property-drag", async () => {
  const row = page.locator("button").filter({ hasText: /球体|立方体/ }).filter({ hasText: /基础元素/ }).first();
  console.log("[probe] 树行 count:", await row.count());
  if (await row.count()) { await row.click(); await page.waitForTimeout(250); }
  console.log("[probe] 此刻 range 总数:", await page.locator('input[type="range"]').count());
  const sliders = page.locator('input[type="range"]');
  const total = await sliders.count();
  let box = null;
  for (let i = 0; i < total; i += 1) {
    const b = await sliders.nth(i).boundingBox();
    if (b && b.width > 40 && b.y > 100) { box = b; break; }
  }
  if (!box) { console.log("[probe] 无可用滑块, sliders=", total); return; }
  const sx = box.x + box.width / 2, sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy); await page.mouse.down();
  for (let i = 0; i < 60; i += 1) {
    await page.mouse.move(sx + Math.sin(i / 60 * Math.PI * 4) * box.width * 0.45, sy);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
});

// 相 4:撤销 ×10 → 面板开关 ×12
await runPhase("panels", async () => {
  for (let i = 0; i < 6; i += 1) {
    await openDockMenu("查看与分析");
    await page.getByRole("menuitem", { name: "场景导演台", exact: true }).click(); await page.waitForTimeout(80);
    await openDockMenu("查看与分析");
    await page.getByRole("menuitem", { name: "场景导演台", exact: true }).click(); await page.waitForTimeout(80);
    await openDockMenu("查看与分析");
    await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click(); await page.waitForTimeout(80);
    await openDockMenu("查看与分析");
    await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click(); await page.waitForTimeout(80);
  }
});

// 相 3:撤销 ×10(先点画布保证焦点)
await runPhase("undo", async () => {
  await page.mouse.click(cx + 60, cy + 60);
  await page.waitForTimeout(150);
  for (let i = 0; i < 10; i += 1) {
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(100);
  }
});

// 相 6:污染会话轨道拖拽(面板开合之后,验证对抗轮 P0-5 污染假设)
await runPhase("orbit-after", orbitDrag);

// 相 7:选中对象后再轨道拖拽(验证 v1 182 提交的污染条件=选中态)
await runPhase("select-orbit", async () => {
  // 先创建一个球并放置(确保有对象可选中)
  await openDockMenu("创建");
  await page.getByRole("menuitem", { name: "球体", exact: true }).click();
  await page.mouse.click(cx - 100, cy - 60);
  await page.waitForTimeout(300);
  // 点它选中
  await page.mouse.click(cx - 100, cy - 60);
  await page.waitForTimeout(300);
  await orbitDrag();
});

const longTaskList = await page.evaluate(() => window.__stormLongTasks);
const commits = await page.evaluate(() => window.__stormCommits);
const heap = await page.evaluate(() => { clearInterval(window.__stormHeapTimer); return window.__stormHeap; });

function aggregateProfile(profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfMicros = new Map();
  for (let i = 1; i < profile.samples.length; i += 1) {
    const node = nodes.get(profile.samples[i]);
    const dt = profile.timeDeltas[i] ?? 0;
    if (node) selfMicros.set(node.id, (selfMicros.get(node.id) ?? 0) + dt);
  }
  const total = [...selfMicros.values()].reduce((a, b) => a + b, 0) || 1;
  const bucketOf = (fn) => {
    const url = fn.url ?? "";
    const name = fn.functionName || "(anonymous)";
    if (name === "(garbage collector)") return "GC";
    if (/(scheduler|performWorkUntilDeadline|workLoop|flushPassiveEffects|commitRoot|beginWork|completeWork|renderRoot|reconcile|createElement|jsxDEV|commitMutationEffects|recursivelyTraverse|captureCommitPhaseError)/i.test(name) || /react/i.test(url)) return "React渲染/提交";
    if (/three\.module|three\.core/.test(url)) return "three(引擎渲染)";
    if (/\/src\/viewer|deep-engine/i.test(url)) return "viewer/engine 桥";
    if (url.includes("/src/")) return "应用代码(app)";
    if (/node_modules/.test(url)) return "其他三方库";
    return "native/idle/其他";
  };
  const buckets = new Map();
  const tops = [];
  for (const [id, us] of selfMicros) {
    const cf = nodes.get(id).callFrame;
    const bucket = bucketOf(cf);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + us);
    if (us > 2500 && cf.functionName !== "(idle)") tops.push({ fn: cf.functionName || "(anonymous)", url: (cf.url ?? "").replace("http://127.0.0.1:5173", "").slice(-80), selfMs: Math.round(us / 100) / 10 });
  }
  tops.sort((a, b) => b.selfMs - a.selfMs);
  const out = { totalMs: Math.round(total / 100) / 10, buckets: {} };
  for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) out.buckets[k] = `${Math.round((v / total) * 1000) / 10}% (${Math.round(v / 100) / 10}ms)`;
  out.topSelf = tops.slice(0, 14);
  return out;
}

const report = { generatedAt: new Date().toISOString(), phases: [] };
for (const p of phases) {
  const name = p.name;
  const lt = longTaskList.filter((t) => t.phase === name);
  const cm = commits.filter((t) => t.phase === name);
  const hp = heap.filter((h) => h.phase === name);
  const sampled = cm.flatMap((c) => c.sampled ?? []);
  const sampledCount = {};
  for (const s of sampled) sampledCount[s] = (sampledCount[s] ?? 0) + 1;
  report.phases.push({
    phase: name, wallMs: p.wallMs,
    longTasks: { count: lt.length, totalMs: lt.reduce((a, b) => a + b.d, 0), maxMs: lt.reduce((a, b) => Math.max(a, b.d), 0), list: lt.map((l) => l.d) },
    reactCommits: cm.length,
    reRenderSample: Object.fromEntries(Object.entries(sampledCount).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    heap: { startMb: hp[0]?.used ?? 0, endMb: hp[hp.length - 1]?.used ?? 0, peakMb: hp.reduce((a, b) => Math.max(a, b.used), 0) },
    cpu: aggregateProfile(p.profile),
  });
}
report.undoConsole = consoleLogs.filter((l) => /scene-history|撤销/.test(l.text)).slice(0, 12);
writeFileSync(resolve(outDir, "storm-report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.phases.map(({ phase, wallMs, longTasks, reactCommits, heap }) => ({ phase, wallMs, longTasks: `${longTasks.count}个/${longTasks.totalMs}ms(max${longTasks.maxMs})`, commits: reactCommits, heapDeltaMb: Math.round((heap.endMb - heap.startMb) * 10) / 10 })), null, 1));
console.log("undo console:", JSON.stringify(report.undoConsole));
console.log("全文:", resolve(outDir, "storm-report.json"));
await browser.close();
