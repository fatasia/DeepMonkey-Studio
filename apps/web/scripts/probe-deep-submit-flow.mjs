// 定位 Deep WebGPU pointer→submit 跳帧层:同 gate 环境,拖拽期间统计
// rAF 回调数 vs GPUQueue.submit 数 vs pointer→submit 分布,并抓相机快照时序。
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const route = `/studio/${sceneId}?project=${projectId}`;
const output = process.env.FAIR_OUTPUT_DIR
  ? `${process.env.FAIR_OUTPUT_DIR.replace(/[\\/]$/u, "")}/`
  : fileURLToPath(new URL("../../../test-output/deep-submit-flow-probe/", import.meta.url));
await mkdir(output, { recursive: true });

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
const pendingErrors = [];
context.on("page", page => page.on("pageerror", e => pendingErrors.push(`${e.message}\n${e.stack ?? ""}`.slice(0, 600))));
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  // 与 gate 相同:先 webgl 启动,再走 UI 对话框切换,保证手势接管与发布时序一致。
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
page.on("pageerror", e => console.error("pageerror:", e.message));
await page.goto(`${webOrigin}${route}`, { waitUntil: "domcontentloaded" });
const author = page.locator(".viewport canvas:not([data-renderer-backend])").first();
await author.waitFor({ state: "visible" });
await page.waitForTimeout(1_500);
{
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  if (!await dialog.isVisible().catch(() => false)) {
    await page.getByLabel("更多场景工具", { exact: true }).click();
    await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  }
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: "启用 Deep WebGPU Beta", exact: true }).click();
  await page.locator(`.viewport canvas[data-renderer-backend="deep-webgpu"]`).waitFor({ state: "attached", timeout: 120_000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector(`.viewport canvas[data-renderer-backend="deep-webgpu"]`);
    return canvas && getComputedStyle(canvas).opacity === "1";
  }, undefined, { timeout: 120_000 });
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
}
await page.waitForTimeout(2_000);
const gesture = await page.evaluate(() => {
  const deepCanvas = document.querySelector(`.viewport canvas[data-renderer-backend="deep-webgpu"]`);
  const authorCanvas = document.querySelector(`.viewport canvas:not([data-renderer-backend])`);
  const allCanvases = [...document.querySelectorAll("canvas")].map(c => ({
    backend: c.dataset.rendererBackend ?? "author", inViewport: !!c.closest(".viewport"),
    attached: c.getClientRects().length > 0,
    pointerEvents: getComputedStyle(c).pointerEvents,
  }));
  const r = deepCanvas.getBoundingClientRect();
  const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { deepPointerEvents: deepCanvas ? getComputedStyle(deepCanvas).pointerEvents : null,
    authorPointerEvents: authorCanvas ? getComputedStyle(authorCanvas).pointerEvents : null,
    hitAtCenter: el ? `${el.tagName}[${el.dataset?.rendererBackend ?? "author"}]` : null,
    deepCanvasCount: document.querySelectorAll(`canvas[data-renderer-backend="deep-webgpu"]`).length,
    allCanvases };
});
console.log("gesture:", JSON.stringify(gesture, null, 1));

const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
const x = bounds.x + bounds.width * 0.5, y = bounds.y + bounds.height * 0.5;

await page.evaluate(() => {
  const state = { raf: 0, submits: [], pointers: [], pointerToSubmit: [], active: true,
    rafAtSubmit: [], submitToRaf: [], lastRaf: 0, rafTimes: [], presents: [], presentAtRaf: [] };
  window.__deepFlowProbe = { renderDeepFrame: 0, cameraPath: 0, syncPath: 0, coalesced: 0,
    draws: 0, viewMs: 0, renderMs: 0, samples: [] };
  const tick = now => { if (!state.active) return; state.raf++; state.lastRaf = state.raf; state.rafTimes.push(now); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const queuePrototype = globalThis.GPUQueue?.prototype;
  const original = queuePrototype.submit;
  queuePrototype.submit = function (...args) {
    const result = original.apply(this, args);
    if (state.active) {
      state.submits.push(performance.now());
      state.rafAtSubmit.push(state.lastRaf);
      const pointers = state.pointers;
      if (pointers.length) {
        const last = pointers[pointers.length - 1];
        state.pointerToSubmit.push(performance.now() - last);
      }
    }
    return result;
  };
  const ctxPrototype = globalThis.GPUCanvasContext?.prototype;
  if (ctxPrototype?.getCurrentTexture) {
    const originalGet = ctxPrototype.getCurrentTexture;
    ctxPrototype.getCurrentTexture = function (...args) {
      const result = originalGet.apply(this, args);
      if (state.active) { state.presents.push(performance.now()); state.presentAtRaf.push(state.lastRaf); }
      return result;
    };
  }
  document.addEventListener("pointermove", () => {
    if (state.active) state.pointers.push(performance.now());
  }, true);
  window.__probe = state;
});

await page.mouse.move(x, y);
await page.evaluate(() => {
  window.__deepFlowProbe = { renderDeepFrame: 0, cameraPath: 0, syncPath: 0, coalesced: 0,
    draws: 0, viewMs: 0, renderMs: 0, samples: [], syncCount: 0, syncMs: 0 };
});
const rafGaps = [];
await page.evaluate(() => {
  window.__rafTimes = [];
  window.__longTasks = [];
  const tick = now => { window.__rafTimes.push(now); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        window.__longTasks.push({ at: Math.round(entry.startTime), ms: Math.round(entry.duration),
          attribution: entry.attribution?.map(a => a.name ?? a.containerType ?? "").join(",") ?? "" });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch { /* unsupported */ }
});
const dragStartAt = Date.now();
await page.mouse.move(x, y);
await page.mouse.down();
for (let index = 0; index < 120; index++) {
  const phase = index / 119 * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18,
    y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up();
await page.waitForTimeout(300);
const dragStats = await page.evaluate(startMs => {
  const f = window.__deepFlowProbe;
  const times = window.__rafTimes.filter(t => t >= startMs);
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = r => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * r))] ?? null;
  return { renderDeepFrame: f.renderDeepFrame, syncPath: f.syncPath, draws: f.draws,
    shortCircuits: f.shortCircuits ?? -1, keyChanges: f.keyChanges ?? -1,
    syncCount: f.syncCount, syncMsAvg: f.syncCount ? +(f.syncMs / f.syncCount).toFixed(2) : 0,
    demandSnapshot: f.demand ?? null,
    viewMsAvg: f.renderDeepFrame ? +(f.viewMs / f.renderDeepFrame).toFixed(2) : 0,
    renderMsAvg: f.draws ? +(f.renderMs / f.draws).toFixed(2) : 0,
    rafGap: { p50: at(0.5), p95: at(0.95), samples: gaps.length },
    longTasks: (window.__longTasks ?? []).slice(0, 8) };
}, dragStartAt);
console.log("drag:", JSON.stringify(dragStats));
const flowOnly = await page.evaluate(() => {
  const f = window.__deepFlowProbe;
  return { deepFlow: { ...f, samples: undefined }, rafWindowMs: performance.now() };
});
console.log("flow:", JSON.stringify(flowOnly));
const result = await page.evaluate(() => {
  const state = window.__probe;
  state.active = false;
  const gaps = [];
  for (let i = 1; i < state.submits.length; i++) gaps.push(state.submits[i] - state.submits[i - 1]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const ptrSorted = [...state.pointerToSubmit].sort((a, b) => a - b);
  const at = (values, r) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * r))] : null;
  // 每个 rAF 窗口内的 submit 计数分布
  const perRaf = new Map();
  for (const rafIndex of state.rafAtSubmit) perRaf.set(rafIndex, (perRaf.get(rafIndex) ?? 0) + 1);
  const distribution = {};
  for (const count of perRaf.values()) distribution[count] = (distribution[count] ?? 0) + 1;
  // 拖拽窗口内的 rAF 间隔分布(判别 CPU 超预算掉帧 vs animate 主动跳帧)
  const dragStart = state.pointers[0] ?? 0, dragEnd = state.pointers.at(-1) ?? 0;
  const dragRafGaps = [];
  for (let i = 1; i < state.rafTimes.length; i++) {
    if (state.rafTimes[i] >= dragStart && state.rafTimes[i] <= dragEnd + 200) {
      dragRafGaps.push(state.rafTimes[i] - state.rafTimes[i - 1]);
    }
  }
  const rafSorted = [...dragRafGaps].sort((a, b) => a - b);
  const presentGaps = [];
  for (let i = 1; i < state.presents.length; i++) presentGaps.push(state.presents[i] - state.presents[i - 1]);
  const presentSorted = [...presentGaps].sort((a, b) => a - b);
  return { rafCount: state.raf, submitCount: state.submits.length, pointerCount: state.pointers.length,
    presentCount: state.presents.length,
    deepFlow: window.__deepFlowProbe ?? null,
    submitGap: { p50: at(sorted, 0.5), p95: at(sorted, 0.95) },
    presentGap: { p50: at(presentSorted, 0.5), p95: at(presentSorted, 0.95) },
    dragRafGap: { p50: at(rafSorted, 0.5), p95: at(rafSorted, 0.95), samples: dragRafGaps.length },
    pointerToSubmit: { p50: at(ptrSorted, 0.5), p95: at(ptrSorted, 0.95), n: ptrSorted.length },
    rafWindow: state.rafTimes.length > 1 ? (state.rafTimes.at(-1) - state.rafTimes[0]) / (state.rafTimes.length - 1) : null,
    submitsPerRafDistribution: distribution,
    submitRafIndexTail: state.rafAtSubmit.slice(-24) };
});
console.log(JSON.stringify(result, null, 2));
await writeFile(`${output}probe.json`, JSON.stringify(result, null, 2));
await browser.close();
