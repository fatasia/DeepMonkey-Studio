// 输入 P95 归因探针 v3(F2):门全序复刻(static 采样 → 前/右/顶位姿截图 →
// 输入轨迹+16 截图序列)+ mapAsync/Capture-buffer/管线创建计数 + longtask 逐条
// 按"切换后秒数"分桶 + 输入窗口 CPU profiler。定位门 20.8ms 与 readback 归属。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const useWebgl = process.env.WEBGL === "1";
const inputSteps = Number(process.env.FAIR_INPUT_STEPS ?? 120);
const staticSamples = 120;
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
  window.__gpuOps = { mapAsync: [], captureBuffers: 0, pipelines: [], submitTimes: [] };
  const mapOrig = GPUBuffer.prototype.mapAsync;
  GPUBuffer.prototype.mapAsync = function (mode, offset, size) {
    if (window.__gpuOps.mapAsync.length < 200 && (mode & GPUMapMode.READ)) {
      window.__gpuOps.mapAsync.push({ t: Math.round(performance.now()),
        size: this.size, label: (this.label ?? "").slice(0, 60) });
    }
    return mapOrig.call(this, mode, offset, size);
  };
  const createOrig = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function (desc) {
    if (typeof desc?.label === "string" && desc.label.toLowerCase().includes("capture")) window.__gpuOps.captureBuffers++;
    return createOrig.call(this, desc);
  };
  for (const name of ["createRenderPipeline", "createRenderPipelineAsync"]) {
    const orig = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (desc) {
      if (window.__gpuOps.pipelines.length < 300) {
        window.__gpuOps.pipelines.push({ t: Math.round(performance.now()),
          label: String(desc?.label ?? "").slice(0, 60), async: name.endsWith("Async") });
      }
      return orig.call(this, desc);
    };
  }
  const submitOrig = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (cmds) {
    window.__gpuOps.submitTimes.push(Math.round(performance.now()));
    if (window.__gpuOps.submitTimes.length > 4000) window.__gpuOps.submitTimes.shift();
    return submitOrig.call(this, cmds);
  };
}, { token });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.on("pageerror", e => console.error("[pageerror]", e.message.slice(0, 200)));
await page.goto(`${webOrigin}/studio/fedab835-389b-43a5-99be-6820d0f3afde?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1`,
  { waitUntil: "domcontentloaded" });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible" });
await page.waitForTimeout(1_500);

let switchDoneAt = 0;
if (!useWebgl) {
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  await page.getByLabel("更多场景工具", { exact: true }).click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  await dialog.getByRole("button", { name: "启用 Deep WebGPU", exact: true }).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
    return c && getComputedStyle(c).opacity === "1";
  }, undefined, { timeout: 120_000 });
  switchDoneAt = await page.evaluate(() => Math.round(performance.now()));
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
}
await page.waitForTimeout(800);
await page.getByRole("button", { name: "适应整个场景", exact: true }).click();
await page.waitForTimeout(700);

// 观测注入(分段 intervals + longtask)
await page.evaluate(() => {
  const state = { phase: "idle", segments: { drag: [], capture: [] }, longTasks: [], last: performance.now() };
  const tick = now => {
    const interval = now - state.last;
    state.last = now;
    if (state.phase === "drag" || state.phase === "capture") state.segments[state.phase].push(interval);
    requestAnimationFrame(tick);
  };
  const observer = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) state.longTasks.push({ d: Math.round(entry.duration * 10) / 10,
      t: Math.round(entry.startTime), phase: state.phase });
  });
  try { observer.observe({ type: "longtask", buffered: false }); } catch { /* unsupported */ }
  window.__attrib = { state, observer, markPhase(phase) { state.phase = phase; } };
  requestAnimationFrame(tick);
});

const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
// 门同款:static 采样(等价占位,不读堆)→ 位姿 前/右/顶(每个 dispatch click + 900 + 截图×2)
await page.waitForTimeout(2_000);
for (const pose of ["前", "右", "顶"]) {
  await page.getByRole("button", { name: pose, exact: true }).dispatchEvent("click");
  await page.waitForTimeout(900);
  await page.screenshot({ clip: bounds });
  await page.waitForTimeout(250);
  await page.screenshot({ clip: bounds });
}

const cdp = await context.newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.start");
await page.evaluate(() => window.__attrib.markPhase("drag"));
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
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
  await page.screenshot({ clip: bounds });
}
await page.mouse.up();
await page.waitForTimeout(100);
await page.evaluate(() => window.__attrib.markPhase("idle"));
const timing = await page.evaluate(({ switchDoneAt }) => {
  const session = window.__attrib;
  const state = session.state;
  const now = Math.round(performance.now());
  session.observer.disconnect();
  const summarize = values => {
    const ordered = [...values].sort((a, b) => a - b);
    const at = ratio => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? null;
    return { samples: ordered.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: ordered[ordered.length - 1] ?? null };
  };
  const dragFrames = state.segments.drag.slice(1);
  const captureFrames = state.segments.capture.slice(1);
  const ops = window.__gpuOps;
  return { switchDoneAt, pageNow: now,
    drag: summarize(dragFrames), capture: summarize(captureFrames),
    longTasks: state.longTasks,
    mapAsyncReads: ops.mapAsync,
    captureBuffersCreated: ops.captureBuffers,
    pipelineCreates: ops.pipelines.filter(p => p.t > (ops.pipelines[0]?.t ?? 0)).length,
    pipelineLabelTail: ops.pipelines.slice(-8),
    submitCount: ops.submitTimes.length };
}, { switchDoneAt });
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
