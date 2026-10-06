// 输入 P95 归因探针 v2(F2):完全复刻 gate-deep-fair-comparison 的测量序
// (位姿截图 → 输入轨迹 120 步 → 16 步截图序列),分段统计帧间隔,定位
// 20.8ms P95 的构成(拖拽期 vs 截图期)+ longtask 绝对时点归段。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const useWebgl = process.env.WEBGL === "1";
const inputSteps = Number(process.env.FAIR_INPUT_STEPS ?? 120);
const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const { token } = await login.json();
const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.on("pageerror", e => console.error("[pageerror]", e.message.slice(0, 200)));
await page.goto(`${webOrigin}/studio/fedab835-389b-43a5-99be-6820d0f3afde?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1`,
  { waitUntil: "domcontentloaded" });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible" });
await page.waitForTimeout(1_500);

if (!useWebgl) {
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  await page.getByLabel("更多场景工具", { exact: true }).click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  await dialog.getByRole("button", { name: "启用 Deep WebGPU", exact: true }).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
    return c && getComputedStyle(c).opacity === "1";
  }, undefined, { timeout: 120_000 });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
}
await page.waitForTimeout(800);
await page.getByRole("button", { name: "适应整个场景", exact: true }).click();
await page.waitForTimeout(700);

// 观测注入:分段 intervals + longtask + submit 分段
await page.evaluate(() => {
  const state = { phase: "idle", segments: { drag: [], capture: [] }, longTasks: [],
    pointerSerial: 0, pointerAt: 0, backendSerial: 0, submitInDrag: 0, submitInCapture: 0,
    submitGapDrag: [], lastSubmit: 0, submitSeen: 0, last: performance.now(), screenshotAt: [] };
  const tick = now => {
    const interval = now - state.last;
    state.last = now;
    if (state.phase === "drag" || state.phase === "capture") {
      state.segments[state.phase].push(interval);
      if (state.lastSubmit && state.phase === "drag") {
        if (state.lastSubmit > state.submitSeen) { state.submitGapDrag.push(now - state.lastSubmit); state.submitSeen = state.lastSubmit; }
      }
    }
    requestAnimationFrame(tick);
  };
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.longTasks.push({ d: Math.round(entry.duration * 10) / 10,
      t: Math.round(entry.startTime), phase: state.phase });
  });
  try { observer.observe({ type: "longtask", buffered: false }); } catch { /* unsupported */ }
  const pointer = () => { state.pointerSerial++; state.pointerAt = performance.now(); };
  const recordBackend = () => {
    const now = performance.now();
    if (state.phase === "drag") state.submitInDrag++;
    if (state.phase === "capture") state.submitInCapture++;
    if (state.phase !== "drag" && state.phase !== "capture") { state.lastSubmit = now; return; }
    if (state.pointerSerial === state.backendSerial) { state.lastSubmit = now; return; }
    state.backendSerial = state.pointerSerial;
    state.pointerSubmitMs = now - state.pointerAt;
    if (state.phase === "drag") { (state.submitAfterPointer = state.submitAfterPointer ?? []).push(state.pointerSubmitMs); }
    state.lastSubmit = now;
  };
  const restores = [];
  const queuePrototype = globalThis.GPUQueue?.prototype;
  if (queuePrototype?.submit) {
    const original = queuePrototype.submit;
    queuePrototype.submit = function (...args) { const r = original.apply(this, args); recordBackend(); return r; };
    restores.push(() => { queuePrototype.submit = original; });
  }
  for (const prototype of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
    if (!prototype?.drawElements) continue;
    const original = prototype.drawElements;
    prototype.drawElements = function (...args) { const r = original.apply(this, args); recordBackend(); return r; };
    restores.push(() => { prototype.drawElements = original; });
  }
  document.addEventListener("pointermove", pointer, true);
  window.__attrib = { state, observer, pointer, restores, markPhase(phase) { state.phase = phase; } };
  requestAnimationFrame(tick);
});

const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;

// CDP profiler 全程开启(输入轨迹段)
const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.start");
await page.evaluate(() => window.__attrib.markPhase("drag"));
await page.mouse.move(x, y);
await page.mouse.down();
for (let index = 0; index < inputSteps; index++) {
  const phase = index / Math.max(1, inputSteps - 1) * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18,
    y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(100);
await page.mouse.move(x, y);
await page.mouse.down();
await page.evaluate(() => window.__attrib.markPhase("capture"));
for (let index = 0; index < 16; index++) {
  await page.mouse.move(x + (index % 2 ? 1 : -1) * bounds.width * 0.12,
    y + Math.sin(index) * bounds.height * 0.04);
  await page.waitForTimeout(20);
  await page.evaluate(at => window.__attrib.state.screenshotAt.push(Math.round(performance.now() - at)), performance.now());
  await page.screenshot({ clip: bounds });
}
await page.mouse.up();
await page.waitForTimeout(100);
await page.evaluate(() => window.__attrib.markPhase("idle"));
const timing = await page.evaluate(() => {
  const session = window.__attrib;
  const state = session.state;
  session.observer.disconnect();
  document.removeEventListener("pointermove", session.pointer, true);
  for (const restore of session.restores) restore();
  const summarize = values => {
    const ordered = [...values].sort((a, b) => a - b);
    const at = ratio => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? null;
    return { samples: ordered.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: ordered[ordered.length - 1] ?? null };
  };
  const dragFrames = state.segments.drag.slice(1);
  const captureFrames = state.segments.capture.slice(1);
  const combined = [...dragFrames, ...captureFrames];
  const captureWindow = { start: Math.min(...state.screenshotAt, Infinity), end: Math.max(...state.screenshotAt, -Infinity) };
  return { drag: { ...summarize(dragFrames), submitCount: state.submitInDrag },
    capture: { ...summarize(captureFrames), submitCount: state.submitInCapture,
      perShotInterval: captureFrames.slice(-16).map(v => Math.round(v)) },
    combined: summarize(combined),
    longTasks: state.longTasks,
    captureWindow,
    submitAfterPointer: summarize(state.submitAfterPointer ?? []) };
});
const { profile } = await cdp.send("Profiler.stop");
await browser.close();

const nodesById = new Map(profile.nodes.map(node => [node.id, node]));
const selfUs = new Map();
for (const node of profile.nodes) selfUs.set(node.id, 0);
const deltas = profile.timeDeltas ?? [];
const samplesArr = profile.samples ?? [];
for (let index = 0; index < samplesArr.length; index++) {
  selfUs.set(samplesArr[index], (selfUs.get(samplesArr[index]) ?? 0) + Math.max(0, deltas[index] ?? 0));
}
const hot = [...selfUs.entries()]
  .map(([id, us]) => {
    const node = nodesById.get(id);
    const cf = node?.callFrame ?? {};
    const file = (cf.url ?? "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/@fs\//, "").slice(-90);
    return { fn: `${cf.functionName || "(anon)"} @ ${file}:${cf.lineNumber ?? "?"}`, selfMs: Math.round(us / 100) / 10 };
  })
  .filter(item => item.selfMs > 0)
  .sort((a, b) => b.selfMs - a.selfMs)
  .slice(0, 30);
const label = useWebgl ? "webgl" : "deep-webgpu";
console.log(JSON.stringify({ backend: label, ...timing, cpuSelfHot: hot }, null, 1));
