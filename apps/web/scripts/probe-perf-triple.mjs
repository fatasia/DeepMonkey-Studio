// 性能三联基线/复测探针:1000 物场景动态帧三维度 + Long Task 全会话计数。
// A 腿(拖拽):rAF 间隔 P95(端到端)+ Deep encoder→submit 跨度(CPU 提交)
//   + queue.writeBuffer 逐调用计数/字节(同步批量化证据)+ 拖拽窗口 longtask。
// B 腿(静置 + 诊断面板开):解码 "Deep timing readback"(32B=4 时间戳)得
//   gpu-frame 毫秒分布(GPU 执行)。两腿各自独立浏览器会话,口径一致可复测。
// 用法:node scripts/probe-perf-triple.mjs;环境变量 FAIR_INPUT_STEPS/WEBGL 同 r3。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
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

const OBSERVER_SCRIPT = ({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
  window.__obs = { phase: "idle", intervals: [], longTasks: [], submits: [], encoders: [], writeBuffers: [],
    gpuFrames: [], pipelineTimes: [], heap: [], last: performance.now(), pipelines: 0 };
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) window.__obs.longTasks.push({
      d: Math.round(entry.duration), t: Math.round(entry.startTime), phase: window.__obs.phase });
  }).observe({ type: "longtask", buffered: true });
  const tick = now => {
    const interval = now - window.__obs.last;
    window.__obs.last = now;
    if (window.__obs.phase === "drag") window.__obs.intervals.push(Math.round(interval * 100) / 100);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  const mapOrig = GPUBuffer.prototype.mapAsync;
  GPUBuffer.prototype.mapAsync = function (mode, offset, size) {
    const isFrameTiming = this.size === 32 && (this.label ?? "").includes("Deep timing readback");
    const promise = mapOrig.call(this, mode, offset, size);
    if (isFrameTiming && window.__obs.gpuFrames.length < 2000) {
      return promise.then(() => {
        const times = new BigUint64Array(this.getMappedRange());
        const ms = Number(times[1] - times[0]) / 1e6;
        if (Number.isFinite(ms) && ms >= 0) window.__obs.gpuFrames.push({
          t: Math.round(performance.now()), ms: Math.round(ms * 1000) / 1000 });
      });
    }
    return promise;
  };
  const createOrig = GPUDevice.prototype.createCommandEncoder;
  GPUDevice.prototype.createCommandEncoder = function (desc) {
    const label = String(desc?.label ?? "");
    if (label.startsWith("Deep")) window.__obs.encoders.push(performance.now());
    return createOrig.call(this, desc);
  };
  const submitOrig = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (commands) {
    const now = performance.now();
    const pending = window.__obs.encoders;
    window.__obs.encoders = [];
    if (pending.length && window.__obs.submits.length < 4000) {
      window.__obs.submits.push({ t: Math.round(now), spanUs: Math.round((now - pending[0]) * 1000) });
    }
    return submitOrig.call(this, commands);
  };
  const writeOrig = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (buffer, offset, data) {
    const slot = window.__obs;
    if (slot.writeBuffers.length < 20000) {
      const bytes = data?.byteLength ?? data?.buffer?.byteLength ?? 0;
      slot.writeBuffers.push({ t: Math.round(performance.now()), b: bytes, l: (buffer.label ?? "").slice(0, 40) });
    }
    return writeOrig.call(this, buffer, offset, data);
  };
  for (const name of ["createRenderPipeline", "createRenderPipelineAsync", "createComputePipeline", "createComputePipelineAsync"]) {
    const orig = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (desc) {
      window.__obs.pipelines++;
      window.__obs.pipelineTimes.push({ t: Math.round(performance.now()), l: String(desc?.label ?? "").slice(0, 40) });
      return orig.call(this, desc);
    };
  }
  const heapTimer = setInterval(() => {
    const slot = window.__obs;
    if (slot.heap.length < 2400) slot.heap.push({ t: Math.round(performance.now()),
      used: Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576) });
  }, 50);
  window.__obs.heapTimer = heapTimer;
  window.__obs.passFrames = new Map();
  const passSampler = setInterval(() => {
    const timings = window.__deepQualityTelemetry?.latestPassTimings;
    if (timings?.availability === "measured" && timings.milliseconds !== undefined
      && !window.__obs.passFrames.has(timings.frame) && window.__obs.passFrames.size < 4000) {
      window.__obs.passFrames.set(timings.frame, { frame: timings.frame, totalMs: timings.milliseconds,
        passes: (timings.passes ?? []).map(p => ({ id: p.passId, ms: p.durationMs })) });
    }
  }, 30);
  window.__obs.passSampler = passSampler;
};

async function runLeg(contextOptions, legSetup, urlSuffix = "") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...contextOptions });
  await context.addInitScript(OBSERVER_SCRIPT, { token });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", e => console.error("[pageerror]", e.message.slice(0, 160)));
  await page.goto(`${webOrigin}/studio/fedab835-389b-43a5-99be-6820d0f3afde?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1${urlSuffix}`,
    { waitUntil: "domcontentloaded" });
  await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible" });
  await page.waitForTimeout(1_500);
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  await page.getByLabel("更多场景工具", { exact: true }).click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  await dialog.getByRole("button", { name: "启用 Deep WebGPU", exact: true }).click();
  await page.waitForFunction(() => {
    const c = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
    return c && getComputedStyle(c).opacity === "1";
  }, undefined, { timeout: 120_000 });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "适应整个场景", exact: true }).click();
  await page.waitForTimeout(700);
  const result = await legSetup(page);
  const report = await page.evaluate(() => {
    const obs = window.__obs;
    const summarize = values => {
      const ordered = [...values].sort((a, b) => a - b);
      const at = ratio => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? null;
      return { samples: ordered.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: ordered[ordered.length - 1] ?? null };
    };
    const dragStart = obs.dragStartedAt ?? 0, dragEnd = obs.dragEndedAt ?? Number.MAX_SAFE_INTEGER;
    const dragSubmits = obs.submits.filter(s => s.t >= dragStart - 50 && s.t <= dragEnd + 150);
    const dragWrites = obs.writeBuffers.filter(w => w.t >= dragStart - 50 && w.t <= dragEnd + 150);
    const dragGpu = obs.gpuFrames.filter(g => g.t >= dragStart - 50 && g.t <= dragEnd + 150);
    const totalMs = arr => arr.reduce((sum, item) => sum + (item.d ?? item.ms ?? 0), 0);
    const writeBytes = dragWrites.reduce((sum, w) => sum + w.b, 0);
    const heapDropDuring = (heap, from, to) => {
      const inWindow = heap.filter(h => h.t >= from && h.t <= to + 400);
      if (inWindow.length < 2) return 0;
      let max = inWindow[0].used, drop = 0;
      for (const h of inWindow) { if (h.used > max) max = h.used; drop = Math.max(drop, max - h.used); }
      return Math.round(drop);
    };
    const writeGroups = {};
    for (const w of dragWrites) {
      const key = w.l || "(unlabeled)";
      writeGroups[key] = writeGroups[key] ?? { calls: 0, bytes: 0 };
      writeGroups[key].calls++; writeGroups[key].bytes += w.b;
    }
    return {
      dragInterval: summarize(obs.intervals.slice(1)),
      cpuSubmitSpanUs: { samples: dragSubmits.length, p50: dragSubmits.length ? summarize(dragSubmits.map(s => s.spanUs)).p50 : null,
        p95: dragSubmits.length ? summarize(dragSubmits.map(s => s.spanUs)).p95 : null,
        max: dragSubmits.length ? summarize(dragSubmits.map(s => s.spanUs)).max : null },
      gpuFrameMs: summarize(dragGpu.map(g => g.ms)),
      longTasksAll: { count: obs.longTasks.length, totalMs: Math.round(totalMs(obs.longTasks)),
        max: obs.longTasks.reduce((m, t) => Math.max(m, t.d), 0),
        items: obs.longTasks.map(t => ({ ...t,
          pipelinesNearby: obs.pipelineTimes.filter(p => p.t >= t.t - 30 && p.t <= t.t + t.d + 30).length,
          heapDropMb: heapDropDuring(obs.heap, t.t, t.t + t.d) })) },
      longTasksDrag: { count: obs.longTasks.filter(t => t.phase === "drag").length,
        items: obs.longTasks.filter(t => t.phase === "drag").slice(0, 12) },
      writeBuffers: { calls: dragWrites.length, bytes: writeBytes, groups: writeGroups },
      pipelineCreatesTotal: obs.pipelines, submitTotal: obs.submits.length };
  });
  await context.close();
  return { ...report, ...(result ?? {}) };
}

// A 腿:拖拽 120 步。
const legA = await runLeg({}, async page => {  const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
  await page.waitForTimeout(1_000);
  await page.evaluate(() => { window.__obs.phase = "drag"; window.__obs.dragStartedAt = Math.round(performance.now()); });
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
  await page.evaluate(() => { window.__obs.dragEndedAt = Math.round(performance.now()); window.__obs.phase = "idle"; });
  await page.waitForTimeout(150);
});

// B 腿:?t25-gpu-pass-timing=1 + 拖拽 —— 逐 pass GPU 计时(帧级短路与面板开关均不影响:
// 该 URL 参数在渲染器构造期永久启用诊断采样与逐 pass 计时)。同时抓主 pass 绘制量与执行 pass 清单。
const legB = await runLeg({}, async page => {
  const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
  await page.waitForTimeout(1_000);
  await page.evaluate(() => { window.__obs.phase = "drag"; window.__obs.dragStartedAt = Math.round(performance.now()); });
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
  await page.evaluate(() => { window.__obs.dragEndedAt = Math.round(performance.now()); window.__obs.phase = "idle"; });
  await page.waitForTimeout(300);
  const report = await page.evaluate(() => {
    const seen = window.__obs.passFrames ?? new Map();
    const frames = [...seen.values()];
    const totals = frames.map(f => f.totalMs).sort((a, b) => a - b);
    const at = arr => ratio => arr[Math.min(arr.length - 1, Math.floor(arr.length * ratio))] ?? null;
    const aggregate = new Map();
    for (const f of frames) for (const p of f.passes) {
      const slot = aggregate.get(p.id) ?? { count: 0, sumMs: 0, maxMs: 0 };
      slot.count++; slot.sumMs += p.ms; slot.maxMs = Math.max(slot.maxMs, p.ms);
      aggregate.set(p.id, slot);
    }
    const status = window.__deepQualityTelemetry;
    const drawCalls = status?.latestVisibleDraws?.drawCalls ?? null;
    const coverage = status?.latestExecutionCoverage;
    const passCount = status?.collector?.records?.length ? status.collector.records.at(-1)?.passCount : null;
    return { gpuPassTotalMs: { samples: totals.length, p50: at(totals)(0.5), p95: at(totals)(0.95), max: totals[totals.length - 1] ?? null },
      mainPassDrawCalls: drawCalls, frameGraphPassCount: passCount,
      perPass: [...aggregate.entries()].map(([id, s]) => ({ id, avgMs: Math.round(s.sumMs / s.count * 1000) / 1000,
        maxMs: s.maxMs, frames: s.count })).sort((a, b) => b.avgMs - a.avgMs),
      executedPassList: coverage?.executedPassIds ?? null };
  });
  return report;
}, "&t25-gpu-pass-timing=1");

await browser.close();
console.log(JSON.stringify({ backend: "deep-webgpu", inputSteps, legA, legB }, null, 1));
