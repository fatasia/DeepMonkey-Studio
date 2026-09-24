import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import sharp from "sharp";
import { compareImageFiles } from "./renderImageSimilarity.mjs";

// 同场景、同相机、同输入轨迹的三引擎配对对比:Three WebGL(参考) vs Deep WebGPU vs Deep WASM。
// 协议:每后端先"适应整个场景"复位,再依次执行 静置帧时间 → 固定位姿像素守卫 → 固定正弦输入轨迹。
// 判定纪律:跨后端 SSIM 只记录(画风差异不作失败依据);黑帧/亮度/自身确定性是硬守卫;
// 只有 Deep 后端在全部核心指标上不劣于 WebGL 时才输出 exceeds=true,禁止从切换成功推导胜出。

const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const route = `/studio/${sceneId}?project=${projectId}`;
const staticSamples = Number(process.env.FAIR_STATIC_SAMPLES ?? 120);
const inputSteps = Number(process.env.FAIR_INPUT_STEPS ?? 120);
const poses = (process.env.FAIR_POSES ?? "前,右,顶").split(",").map(name => name.trim()).filter(Boolean);
const output = fileURLToPath(new URL("../../../test-output/deep-fair-comparison/", import.meta.url));
await mkdir(output, { recursive: true });

const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
assert.equal(login.status, 200, `Studio login failed: HTTP ${login.status}`);
const { token } = await login.json();

const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});

const report = {
  schema: "deep-monkey.deep-fair-comparison.v1",
  createdAt: new Date().toISOString(),
  route,
  protocol: { staticSamples, inputSteps, poses, referenceBackend: "webgl" },
  backends: {},
  pixelParity: [],
  guards: [],
  exceeds: null,
};
let context;

try {
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ token }) => {
    localStorage.setItem("bim-studio-auth-token", token);
    localStorage.setItem("bim-studio.renderer-backend", "webgl");
  }, { token });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);
  observePage(page);
  await page.goto(`${webOrigin}${route}`, { waitUntil: "domcontentloaded" });
  const author = page.locator(".viewport canvas:not([data-renderer-backend])").first();
  await author.waitFor({ state: "visible" });
  await page.waitForTimeout(1_500);

  for (const backend of ["webgl", "webgpu", "wasm"]) {
    report.backends[backend] = await measureBackend(page, backend);
  }
  await buildPixelParity();
  evaluateVerdict();
  assert.deepEqual(report.guards, [], `fair-comparison guards failed: ${JSON.stringify(report.guards)}`);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  report.passed = false;
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
  await writeFile(`${output}report.md`, renderMarkdown(report));
}

console.log(JSON.stringify(report, null, 2));

function observePage(page) {
  page.on("pageerror", error => report.guards.push({ type: "pageerror", text: error.message }));
  page.on("response", response => {
    if (response.status() >= 500) report.guards.push({ type: "http5xx", status: response.status(), url: response.url() });
  });
}

async function openRendererDialog(page) {
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  if (await dialog.isVisible().catch(() => false)) return dialog;
  await page.getByLabel("更多场景工具", { exact: true }).click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function switchBackend(page, backend) {
  const preference = backend === "webgpu" ? "webgpu" : backend === "wasm" ? "wasm" : "webgl";
  const current = await page.evaluate(() => localStorage.getItem("bim-studio.renderer-backend"));
  if (current !== preference) {
    const dialog = await openRendererDialog(page);
    const button = backend === "webgl" ? "切换到兼容模式"
      : backend === "webgpu" ? "启用 Deep WebGPU Beta" : "启用 Deep WASM";
    await dialog.getByRole("button", { name: button, exact: true }).click();
    if (backend === "webgl") {
      await page.waitForFunction(() => {
        const authorCanvas = document.querySelector(".viewport canvas:not([data-renderer-backend])");
        return authorCanvas && getComputedStyle(authorCanvas).opacity === "1";
      }, undefined, { timeout: 120_000 });
    } else {
      const presented = backend === "webgpu" ? "deep-webgpu" : "deep-wasm";
      await page.locator(`.viewport canvas[data-renderer-backend="${presented}"]`).waitFor({ state: "attached" });
      await page.waitForFunction(expected => {
        const canvas = document.querySelector(`.viewport canvas[data-renderer-backend="${expected}"]`);
        const failed = document.querySelector(".renderer-switch-status.failed");
        return failed || (canvas && getComputedStyle(canvas).opacity === "1");
      }, presented, { timeout: 120_000 });
      const failed = page.locator(".renderer-switch-status.failed");
      if (await failed.count()) throw new Error(`${backend} switch failed: ${await failed.textContent()}`);
    }
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  }
  await page.waitForTimeout(800);
}

async function resetCamera(page) {
  // 适应整个场景是纯 UI 相机复位:同一场景在三后端得到同一位姿,消除状态漂移。
  await page.getByRole("button", { name: "适应整个场景", exact: true }).click();
  await page.waitForTimeout(700);
}

async function measureBackend(page, backend) {
  await switchBackend(page, backend);
  await resetCamera(page);
  const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
  assert.ok(bounds && bounds.width > 100, "author canvas has no usable bounds");
  const presentCanvas = backend === "webgl" ? null
    : page.locator(`.viewport canvas[data-renderer-backend="${backend === "webgpu" ? "deep-webgpu" : "deep-wasm"}"]`);
  const clip = bounds;
  const result = { static: await sampleStaticFrames(page), poses: {}, input: null };
  for (const pose of poses) {
    result.poses[pose] = await capturePose(page, backend, pose, clip);
  }
  result.input = await measureInputTrajectory(page, bounds, backend, presentCanvas);
  return result;
}

async function sampleStaticFrames(page) {
  return page.evaluate(samples => new Promise(resolve => {
    const intervals = [];
    const memory = performance.memory;
    const heapStart = memory ? memory.usedJSHeapSize : null;
    let last = performance.now();
    const tick = now => {
      intervals.push(now - last);
      last = now;
      if (intervals.length >= samples) {
        const sorted = intervals.slice(1).sort((a, b) => a - b);
        const at = ratio => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
        resolve({ sampledFrames: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99),
          maxMs: sorted[sorted.length - 1] ?? 0,
          heapUsedMb: memory && heapStart !== null ? (memory.usedJSHeapSize - heapStart) / 1024 / 1024 : null });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), staticSamples);
}

async function capturePose(page, backend, pose, clip) {
  // 魔方面是 CSS 3D 立方体,DOM 命中测试会被相邻面拦截;产品用户点击的是
  // 视觉朝向面,这里直接向目标面派发 click 事件保证确定性。
  await page.getByRole("button", { name: pose, exact: true }).dispatchEvent("click");
  await page.waitForTimeout(900);
  const first = await page.screenshot({ clip });
  await page.waitForTimeout(250);
  const second = await page.screenshot({ clip });
  const firstPath = `${output}${backend}-${pose}.png`;
  const secondPath = `${output}${backend}-${pose}-repeat.png`;
  await sharp(first).toFile(firstPath);
  await sharp(second).toFile(secondPath);
  const stability = await compareImageFiles(firstPath, secondPath, `${backend}-${pose}`, `${backend}-${pose}-repeat`);
  report.guards.push(...stability.ssim < 0.99
    ? [{ type: "determinism", backend, pose, ssim: stability.ssim }] : []);
  return { screenshot: `${backend}-${pose}.png`, repeatScreenshot: `${backend}-${pose}-repeat.png`,
    determinismSsim: Number(stability.ssim.toFixed(4)), meanAbsoluteError: stability.meanAbsoluteError };
}

async function buildPixelParity() {
  for (const pose of poses) {
    for (const candidate of ["webgpu", "wasm"]) {
      const comparison = await compareImageFiles(`${output}webgl-${pose}.png`, `${output}${candidate}-${pose}.png`,
        `webgl-${pose}`, `${candidate}-${pose}`);
      report.pixelParity.push({ pose, candidate, ssim: Number(comparison.ssim.toFixed(4)),
        meanAbsoluteError: Number(comparison.meanAbsoluteError.toFixed(5)),
        changedPixelRatio: Number((comparison.changedPixelRatio ?? 0).toFixed(4)) });
    }
  }
}

async function measureInputTrajectory(page, bounds, backend, presentCanvas) {
  await page.evaluate(() => {
    const state = { intervals: [], longTasks: [], pointerEvents: 0, active: true, last: performance.now(),
      pointerSerial: 0, pointerAt: 0, backendSerial: 0, gpuFenceSerial: 0,
      pointerToBackendSubmit: [], pointerToGpuComplete: [] };
    const tick = now => {
      if (!state.active) return;
      state.intervals.push(now - state.last);
      state.last = now;
      requestAnimationFrame(tick);
    };
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
    });
    try { observer.observe({ type: "longtask", buffered: false }); } catch { /* unsupported */ }
    const pointer = () => {
      state.pointerEvents++;
      state.pointerSerial++;
      state.pointerAt = performance.now();
    };
    const recordBackend = queue => {
      if (!state.active || state.pointerSerial === state.backendSerial) return;
      state.backendSerial = state.pointerSerial;
      const pointerAt = state.pointerAt;
      state.pointerToBackendSubmit.push(performance.now() - pointerAt);
      if (queue?.onSubmittedWorkDone && state.pointerSerial !== state.gpuFenceSerial
          && state.pointerToGpuComplete.length < 24) {
        state.gpuFenceSerial = state.pointerSerial;
        void queue.onSubmittedWorkDone().then(() => {
          if (state.active) state.pointerToGpuComplete.push(performance.now() - pointerAt);
        });
      }
    };
    const restores = [];
    const queuePrototype = globalThis.GPUQueue?.prototype;
    if (queuePrototype?.submit) {
      const original = queuePrototype.submit;
      queuePrototype.submit = function (...args) {
        const result = original.apply(this, args);
        recordBackend(this);
        return result;
      };
      restores.push(() => { queuePrototype.submit = original; });
    }
    for (const prototype of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) {
      if (!prototype?.drawElements) continue;
      const original = prototype.drawElements;
      prototype.drawElements = function (...args) {
        const result = original.apply(this, args);
        recordBackend(undefined);
        return result;
      };
      restores.push(() => { prototype.drawElements = original; });
    }
    document.addEventListener("pointermove", pointer, true);
    window.__fairInput = { state, observer, pointer, restores };
    requestAnimationFrame(tick);
  });
  const x = bounds.x + bounds.width * 0.5, y = bounds.y + bounds.height * 0.5;
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
  const frames = [];
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let index = 0; index < 16; index++) {
    await page.mouse.move(x + (index % 2 ? 1 : -1) * bounds.width * 0.12,
      y + Math.sin(index) * bounds.height * 0.04);
    await page.waitForTimeout(20);
    frames.push(await page.screenshot({ clip: bounds }));
  }
  await page.mouse.up();
  const timing = await page.evaluate(() => {
    const session = window.__fairInput;
    session.state.active = false;
    session.observer.disconnect();
    document.removeEventListener("pointermove", session.pointer, true);
    for (const restore of session.restores) restore();
    const sorted = session.state.intervals.slice(1).sort((a, b) => a - b);
    const at = (values, ratio) => {
      const ordered = [...values].sort((a, b) => a - b);
      return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * ratio))] ?? null;
    };
    const summarize = values => ({ samples: values.length, p50Ms: at(values, 0.5), p95Ms: at(values, 0.95), p99Ms: at(values, 0.99) });
    delete window.__fairInput;
    return { sampledFrames: sorted.length, pointerEvents: session.state.pointerEvents,
      p50FrameMs: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      p99FrameMs: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
      maxFrameMs: sorted[sorted.length - 1] ?? 0,
      longTaskCount: session.state.longTasks.length,
      pointerToBackendSubmit: summarize(session.state.pointerToBackendSubmit),
      pointerToGpuComplete: summarize(session.state.pointerToGpuComplete) };
  });
  const luminance = [];
  for (const frame of frames) {
    const { data } = await sharp(frame).greyscale().raw().toBuffer({ resolveWithObject: true });
    let sum = 0, nearBlack = 0;
    for (const value of data) { sum += value; if (value < 4) nearBlack++; }
    luminance.push({ mean: sum / data.length, nearBlackRatio: nearBlack / data.length });
  }
  const medianMean = [...luminance].map(item => item.mean).sort((a, b) => a - b)[Math.floor(luminance.length / 2)] ?? 0;
  const blackFrames = luminance.filter(item => item.mean < Math.max(2, medianMean * 0.25)).length;
  const lastPath = `${output}input-${backend}-last.png`;
  await sharp(frames.at(-1)).toFile(lastPath);
  report.guards.push(...(blackFrames > 0 ? [{ type: "blackFrames", backend, blackFrames }] : []));
  report.guards.push(...(medianMean < 5 ? [{ type: "luminanceFloor", backend, medianMean }] : []));
  return { ...timing, blackFrames, medianMeanLuminance: Number(medianMean.toFixed(2)) };
}

function evaluateVerdict() {
  const reference = report.backends.webgl;
  const core = candidate => {
    if (!candidate) return null;
    const better = (a, b) => a <= b;
    return {
      staticP50: better(candidate.static.p50Ms, reference.static.p50Ms),
      staticP95: better(candidate.static.p95Ms, reference.static.p95Ms),
      inputP50Frame: better(candidate.input.p50FrameMs, reference.input.p50FrameMs),
      inputP95Frame: better(candidate.input.p95FrameMs, reference.input.p95FrameMs),
      submitP95: better(candidate.input.pointerToBackendSubmit.p95Ms ?? Infinity,
        reference.input.pointerToBackendSubmit.p95Ms ?? Infinity),
      noBlackFrames: candidate.input.blackFrames === 0,
    };
  };
  report.exceeds = { webgpu: core(report.backends.webgpu), wasm: core(report.backends.wasm) };
}

function renderMarkdown(report) {
  const rows = Object.entries(report.backends).map(([backend, data]) => {
    const input = data.input;
    return `| ${backend} | ${data.static.p50Ms?.toFixed(2) ?? "-"} | ${data.static.p95Ms?.toFixed(2) ?? "-"} | ${input.p50FrameMs?.toFixed(2) ?? "-"} | ${input.p95FrameMs?.toFixed(2) ?? "-"} | ${input.pointerToBackendSubmit?.p95Ms?.toFixed(2) ?? "-"} | ${input.pointerToGpuComplete?.p95Ms?.toFixed(2) ?? "-"} | ${input.blackFrames} | ${input.longTaskCount} |`;
  });
  const parity = report.pixelParity.map(item =>
    `| ${item.pose} | ${item.candidate} | ${item.ssim} | ${(item.meanAbsoluteError * 100).toFixed(2)}% |`);
  return [
    "# Deep vs Three WebGL 同场景同相机公平对比",
    "",
    `生成时间:${report.createdAt};静置采样 ${report.protocol.staticSamples} 帧;输入轨迹 ${report.protocol.inputSteps} 步;固定位姿 ${report.protocol.poses.join("/")}。`,
    "",
    "| 后端 | 静置 P50 ms | 静置 P95 ms | 输入 P50 ms | 输入 P95 ms | pointer→submit P95 ms | pointer→GPU 完成 P95 ms | 黑帧 | Long Task |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    "## 位姿像素对比(参考 = WebGL)",
    "",
    "| 位姿 | 候选 | SSIM | 归一化 MAE |",
    "|---|---|---:|---:|",
    ...parity,
    "",
    `守卫失败:${report.guards.length ? JSON.stringify(report.guards) : "无"}`,
    "",
    `Deep 胜出判定(核心指标全部不劣于 WebGL 才为 true):${JSON.stringify(report.exceeds)}`,
    "",
    "> SSIM 只作记录:跨引擎画风差异不作失败依据。胜出判定必须以本报告的实测数据为准,不得以切换成功推导。",
    "",
  ].join("\n");
}
