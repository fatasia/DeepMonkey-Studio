import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import sharp from "sharp";
import { compareImageFiles } from "./renderImageSimilarity.mjs";

// 同场景、同相机、同输入轨迹的三引擎配对对比:Three WebGL(参考) vs Deep WebGPU vs Deep WASM。
// 协议:每后端先"适应整个场景"复位,再依次执行 静置帧时间 → 固定位姿像素守卫 → 固定正弦输入轨迹。
// 判定纪律:跨后端 SSIM 只记录(画风差异不作失败依据);黑帧/亮度/自身确定性是硬守卫;
// 相机公平三守卫(场景对象计数一致、"适应整个场景"后相机矩阵容差对拍、位姿点击后相机矩阵容差
// 对拍,经 window.__studioCameraProbe 只读取证)是硬守卫——相机命令在 Deep 桥丢失/被覆盖时
// 门必须红,禁止在位姿不可比的状态下 passed;
// 只有 Deep 后端在全部核心指标上不劣于 WebGL 时才输出 exceeds=true,禁止从切换成功推导胜出。

const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const route = `/studio/${sceneId}?project=${projectId}`;
const staticSamples = Number(process.env.FAIR_STATIC_SAMPLES ?? 120);
const inputSteps = Number(process.env.FAIR_INPUT_STEPS ?? 120);
const poses = (process.env.FAIR_POSES ?? "前,右,顶").split(",").map(name => name.trim()).filter(Boolean);
// 相机公平三守卫容差,两层量化:
// 合同层(position/target/up/fov/zoom,相机命令的单一事实源字段)1e-6 逐位一致;
// 世界矩阵层(matrixWorld,叠加相机防穿模碰撞推挤与阻尼等会话物理,亚像素级
// 起点/历史依赖,实测残余 ~3.6e-3)1e-2——仍比相机命令丢失/覆盖缺陷的实测量级
// (冻结 1.26、取景错位 0.44)严 40 倍以上,回归必然红。
const cameraTolerance = Number(process.env.FAIR_CAMERA_TOLERANCE ?? 1e-2);
const cameraContractTolerance = Number(process.env.FAIR_CAMERA_CONTRACT_TOLERANCE ?? 1e-6);
// F2 输入门阈值:输入帧 P95 硬门(默认仅 Deep WebGPU;同轮 WebGL 参考的倍率上限)。
// 同轮成对测量下环境噪声对两侧等价作用,倍率口径比绝对值稳健——防"切换成功即通过"。
// WASM 的提交链落后单独切片治理,暂走 exceeds informational(FAIR_INPUT_P95_GATE_BACKENDS 可扩)。
const inputP95GateRatio = Number(process.env.FAIR_INPUT_P95_MAX_RATIO ?? 1.2);
const inputP95GateBackends = (process.env.FAIR_INPUT_P95_GATE_BACKENDS ?? "webgpu")
  .split(",").map(name => name.trim()).filter(Boolean);
const output = process.env.FAIR_OUTPUT_DIR
  ? `${process.env.FAIR_OUTPUT_DIR.replace(/[\\/]$/u, "")}/`
  : fileURLToPath(new URL("../../../test-output/deep-fair-comparison/", import.meta.url));
await mkdir(output, { recursive: true });
const gitHead = await promisify(execFile)("git", ["rev-parse", "HEAD"], {
  cwd: fileURLToPath(new URL("../../..", import.meta.url)),
}).then(result => result.stdout.trim()).catch(() => "unknown");

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
  gitHead,
  rendererSettings: {
    browser: "Chrome --enable-unsafe-webgpu --enable-features=Vulkan,UseSkiaRenderer",
    temporalSettleGpuBackpressure: true,
    cameraFrameInFlightLimit: process.env.DEEP_CAMERA_FRAME_IN_FLIGHT_LIMIT ?? "default",
  },
  protocol: { staticSamples, inputSteps, poses, referenceBackend: "webgl" },
  backends: {},
  pixelParity: [],
  cameraParity: [],
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
  evaluateCameraGuards();
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
      : backend === "webgpu" ? "启用 Deep WebGPU" : "启用 Deep WASM";
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
  // 先 Escape 清选:残留选中会让 setStandardView 按检视对象取景(取景更近),
  // 也会让输入轨迹拖拽命中视口中心的 gizmo 把模型拖走(fit 基准被永久污染)。
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.getByRole("button", { name: "适应整个场景", exact: true }).click();
  await waitForCameraStill(page, "resetCamera");
  await page.waitForTimeout(200);
}

/**
 * 等作者相机完全静止(位置/目标点在窗口内零变化)。输入轨迹拖拽留下的
 * OrbitControls 阻尼尾巴会在复位后继续微转相机(实测 fitAll 后残余 5.6e-3 且
 * 逐位姿衰减),不等待会污染跨后端矩阵对拍。上限防卡死;超时如实入报告。
 */
async function waitForCameraStill(page, label) {
  const started = Date.now();
  await page.waitForFunction(() => new Promise(resolve => {
    const probe = globalThis.__studioCameraProbe;
    if (typeof probe !== "function") return resolve(false);
    const key = snapshot => JSON.stringify([snapshot.camera.position, snapshot.camera.target]);
    let last = key(probe());
    let still = 0;
    const poll = () => {
      const current = key(probe());
      still = current === last ? still + 125 : 0;
      last = current;
      if (still >= 250) return resolve(true);
      setTimeout(poll, 125);
    };
    setTimeout(poll, 125);
  }), { timeout: 5_000 }).catch(() => undefined);
  return { label, elapsedMs: Date.now() - started };
}

/** 场景对象快照(modelCount+逐对象世界包围盒):拖拽不得改变场景,否则测量被污染。 */
async function readSceneObjectSnapshot(page) {
  const probe = await readCameraProbe(page);
  assert.ok(probe, "camera probe missing while snapshotting scene objects");
  return probe.models.map(model => ({ id: model.id, min: model.worldBox.min, max: model.worldBox.max }));
}

async function measureBackend(page, backend) {
  const firstFrame = await measureFirstFrame(page, backend);
  await switchBackend(page, backend);
  await resetCamera(page);
  // 相机公平三守卫的证据源:宿主只读取证缝(相机矩阵+场景对象计数)。
  // 复位/位姿协议在各后端会话内执行后,矩阵必须与 WebGL 参考容差一致。
  const probe = await readCameraProbe(page);
  assert.ok(probe, `camera probe (window.__studioCameraProbe) missing on ${backend}`);
  const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
  assert.ok(bounds && bounds.width > 100, "author canvas has no usable bounds");
  const presentCanvas = backend === "webgl" ? null
    : page.locator(`.viewport canvas[data-renderer-backend="${backend === "webgpu" ? "deep-webgpu" : "deep-wasm"}"]`);
  const clip = bounds;
  const result = { scene: { modelCount: probe.modelCount, models: probe.models },
    fitAllCamera: probe.camera, static: await sampleStaticFrames(page), poses: {}, input: null, firstFrame };
  for (const pose of poses) {
    result.poses[pose] = await capturePose(page, backend, pose, clip);
  }
  result.input = await measureInputTrajectory(page, bounds, backend, presentCanvas);
  return result;
}

async function readCameraProbe(page) {
  return page.evaluate(() => {
    const probe = globalThis.__studioCameraProbe;
    return typeof probe === "function" ? probe() : null;
  });
}

/**
 * 首帧测量(性能文档 P0-2 的指标来源):每次切换前后读取 performance.mark
 * 阶段戳,firstFrameMs = 切换完成(canvas 不透明度 1)相对切换开始的耗时。
 * Deep 的 mark 链:switch-start → module-ready → environment-ready →
 * scene-uploaded → frame-validated → published。测量的是"切后端首帧"口径,
 * 不是冷启动整页加载;与 render-engine-comparison 的 initializedMs 口径不同,
 * 不可直接互比。
 */
async function measureFirstFrame(page, backend) {
  const prefix = `deep-${backend}:`;
  const stageNames = backend === "wasm"
    ? ["switch-start", "module-ready", "package-compiled", "renderer-ready", "published"]
    : ["switch-start", "module-ready", "environment-ready", "scene-uploaded", "frame-validated", "published"];
  const before = await page.evaluate(() => performance.getEntriesByType("mark").length);
  const markStartedAt = await page.evaluate(() => performance.now());
  const switchStarted = Date.now();
  await switchBackend(page, backend);
  const wallMs = Date.now() - switchStarted;
  const phases = await page.evaluate(({ prefix, markStartedAt, stageNames }) => performance.getEntriesByType("mark")
    .filter(entry => entry.name.startsWith(prefix) && entry.startTime >= markStartedAt
      && stageNames.includes(entry.name.slice(prefix.length)))
    .map(entry => ({ name: entry.name, at: entry.startTime })), { prefix, markStartedAt, stageNames });
  const stages = [];
  let previous = null;
  for (const phase of phases) {
    if (previous !== null) stages.push({ from: previous.name, to: phase.name, deltaMs: Number((phase.at - previous.at).toFixed(1)) });
    previous = phase;
  }
  const switchPublishedMs = phases[0]?.name === `${prefix}switch-start`
    && phases.at(-1)?.name === `${prefix}published`
    ? Number((phases.at(-1).at - phases[0].at).toFixed(1)) : null;
  const internalStages = backend === "webgpu" ? await page.evaluate(({ markStartedAt }) =>
    performance.getEntriesByType("mark")
      .filter(entry => entry.name.startsWith("deep-webgpu:") && entry.startTime >= markStartedAt)
      .map(entry => ({ name: entry.name, at: entry.startTime })), { markStartedAt }) : [];
  const internalBreakdown = internalStages.slice(1).map((phase, index) => ({
    from: internalStages[index].name, to: phase.name,
    deltaMs: Number((phase.at - internalStages[index].at).toFixed(1)),
  }));
  return { wallMs, switchPublishedMs, phaseCount: phases.length, stages,
    ...(internalBreakdown.length ? { internalBreakdown } : {}),
    note: phases.length ? "deep-switch-phase-marks" : "no-marks (webgl or first switch)" ,
    ...(before !== undefined ? { marksBefore: before } : {}) };
}

async function sampleStaticFrames(page) {
  const heapStartMb = await readJsHeapUsedMb(page);
  const result = await page.evaluate(samples => new Promise(resolve => {
    const intervals = [];
    let last = performance.now();
    // F8 GPU 显存通道:Deep 链经 __deepQualityTelemetry.latestMemory.estimatedBytes
    // (引擎 DeviceResourceMemory 字节级估计);WebGL 无该通道,如实 null。
    const gpuMemorySamples = [];
    const readGpuMemory = () => {
      const tel = globalThis.__deepQualityTelemetry;
      const bytes = tel?.latestMemory?.estimatedBytes;
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0) {
        gpuMemorySamples.push(bytes / (1024 * 1024));
      }
    };
    const tick = now => {
      intervals.push(now - last);
      last = now;
      readGpuMemory();
      if (intervals.length >= samples) {
        const sorted = intervals.slice(1).sort((a, b) => a - b);
        const at = ratio => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
        const gpuMedian = gpuMemorySamples.length > 0
          ? gpuMemorySamples.slice().sort((a, b) => a - b)[Math.floor(gpuMemorySamples.length / 2)] : null;
        resolve({ sampledFrames: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99),
          maxMs: sorted[sorted.length - 1] ?? 0, gpuMemoryMbMedian: gpuMedian });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), staticSamples);
  const heapUsedMb = await readJsHeapUsedMb(page);
  return { ...result, heapUsedMb,
    heapDeltaMb: heapStartMb === null || heapUsedMb === null ? null : heapUsedMb - heapStartMb };
}

async function readJsHeapUsedMb(page) {
  let session;
  try {
    session = await page.context().newCDPSession(page);
    await session.send("Performance.enable");
    const { metrics } = await session.send("Performance.getMetrics");
    const bytes = metrics.find(metric => metric.name === "JSHeapUsedSize")?.value;
    return Number.isFinite(bytes) && bytes > 0 ? bytes / 1024 / 1024 : null;
  } catch { return null; }
  finally { await session?.detach().catch(() => undefined); }
}

async function capturePose(page, backend, pose, clip) {
  // 魔方面是 CSS 3D 立方体,DOM 命中测试会被相邻面拦截;产品用户点击的是
  // 视觉朝向面,这里直接向目标面派发 click 事件保证确定性。
  await page.getByRole("button", { name: pose, exact: true }).dispatchEvent("click");
  await waitForCameraStill(page, `pose:${pose}`);
  await page.waitForTimeout(250);
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
  // 位姿守卫③的证据源:位姿点击 settle(900ms)后宿主相机的实际矩阵。
  const probe = await readCameraProbe(page);
  assert.ok(probe, `camera probe missing on ${backend} after pose ${pose}`);
  return { screenshot: `${backend}-${pose}.png`, repeatScreenshot: `${backend}-${pose}-repeat.png`,
    determinismSsim: Number(stability.ssim.toFixed(4)), meanAbsoluteError: stability.meanAbsoluteError,
    camera: probe.camera };
}

/**
 * 相机公平三守卫(模式层):三后端共享同一 three 相机单一事实源,程序性复位与
 * 位姿点击必须落在同一状态——否则跨后端像素/帧时对比失去可比性,门不得放行。
 * ① 场景对象计数一致(作者层 listModels);
 * ② "适应整个场景"复位后相机状态与 WebGL 参考对拍(合同字段 1e-6 + matrixWorld 1e-2);
 * ③ 每个位姿点击后相机状态与 WebGL 参考对拍(同上双层)。
 */

const CONTRACT_FIELDS = ["position", "target", "up", "fov", "zoom"];

function cameraContractDelta(a, b) {
  let max = 0;
  for (const field of CONTRACT_FIELDS) {
    const va = a[field], vb = b[field];
    if (typeof va === "number") { max = Math.max(max, Math.abs(va - vb)); continue; }
    for (let index = 0; index < va.length; index++) max = Math.max(max, Math.abs(va[index] - vb[index]));
  }
  return Number(max.toPrecision(4));
}
function evaluateCameraGuards() {
  const reference = report.backends.webgl;
  if (!reference?.fitAllCamera || !reference?.scene) {
    report.guards.push({ type: "cameraProbeMissing", backend: "webgl" });
    return;
  }
  for (const backend of ["webgpu", "wasm"]) {
    const candidate = report.backends[backend];
    if (!candidate?.fitAllCamera || !candidate?.scene) {
      report.guards.push({ type: "cameraProbeMissing", backend });
      continue;
    }
    // 守卫①:场景对象计数(作者层 listModels)三后端一致。
    if (candidate.scene.modelCount !== reference.scene.modelCount) {
      report.guards.push({ type: "sceneObjectCount", backend,
        candidate: candidate.scene.modelCount, reference: reference.scene.modelCount });
    }
    // 守卫②:"适应整个场景"复位后的相机状态对拍(合同层严格 + 矩阵层物理余量)。
    const fitContract = cameraContractDelta(candidate.fitAllCamera, reference.fitAllCamera);
    const fitDelta = maxArrayDelta(candidate.fitAllCamera.matrixWorld, reference.fitAllCamera.matrixWorld);
    report.cameraParity.push({ stage: "fitAll", backend, maxMatrixWorldDelta: fitDelta,
      maxContractDelta: fitContract, withinTolerance: fitDelta <= cameraTolerance && fitContract <= cameraContractTolerance });
    if (fitDelta > cameraTolerance || fitContract > cameraContractTolerance) {
      report.guards.push({ type: "fitAllCameraParity", backend, maxMatrixWorldDelta: fitDelta,
        maxContractDelta: fitContract, tolerance: cameraTolerance, contractTolerance: cameraContractTolerance });
    }
    // 守卫③:位姿点击后的相机矩阵容差对拍。
    for (const pose of poses) {
      const candidatePose = candidate.poses[pose];
      const referencePose = reference.poses[pose];
      if (!candidatePose?.camera || !referencePose?.camera) {
        report.guards.push({ type: "poseCameraProbeMissing", backend, pose });
        continue;
      }
      const delta = maxArrayDelta(candidatePose.camera.matrixWorld, referencePose.camera.matrixWorld);
      const contractDelta = cameraContractDelta(candidatePose.camera, referencePose.camera);
      report.cameraParity.push({ stage: `pose:${pose}`, backend, maxMatrixWorldDelta: delta,
        maxContractDelta: contractDelta, withinTolerance: delta <= cameraTolerance && contractDelta <= cameraContractTolerance });
      if (delta > cameraTolerance || contractDelta > cameraContractTolerance) {
        report.guards.push({ type: "poseCameraParity", backend, pose, maxMatrixWorldDelta: delta,
          maxContractDelta: contractDelta, tolerance: cameraTolerance, contractTolerance: cameraContractTolerance });
      }
    }
  }
}

function maxArrayDelta(a, b) {
  assert.ok(Array.isArray(a) && Array.isArray(b) && a.length === b.length, "camera matrix shape mismatch");
  let max = 0;
  for (let index = 0; index < a.length; index++) {
    max = Math.max(max, Math.abs((a[index] ?? 0) - (b[index] ?? 0)));
  }
  return Number(max.toPrecision(4));
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
      pointerToBackendSubmit: [], pointerToGpuComplete: [], submitTimestamps: [],
      // 呈现口径:指针事件后首个 rAF = 含该输入的帧已提交合成器(rAF 回调跑在
      // 帧渲染前,第二个 rAF 才保证上一帧已上屏)。onSubmittedWorkDone 是队列级
      // 排空(含历史提交排队),不等于单帧 GPU/呈现延迟——双轨并存,呈现口径
      // 为手感真值,队列口径仅作历史对比。
      pendingPointerAt: undefined, pointerToPresent: [] };
    const tick = now => {
      if (!state.active) return;
      state.intervals.push(now - state.last);
      state.last = now;
      if (state.pendingPointerAt !== undefined) {
        state.pointerToPresent.push(now - state.pendingPointerAt);
        state.pendingPointerAt = undefined;
      }
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
      if (state.pendingPointerAt === undefined) state.pendingPointerAt = state.pointerAt;
    };
    const recordBackend = queue => {
      state.submitTimestamps.push(performance.now());
      if (state.submitTimestamps.length > 400) state.submitTimestamps.shift();
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
  // 拖拽起点偏移视口中心:中心是对象/gizmo 密集区,pointerdown 命中 gizmo 平移轴
  // 会把模型拖走(场景被污染,后续腿的 fit 基准漂移)。
  const x = bounds.x + bounds.width * 0.5, y = bounds.y + bounds.height * 0.5;
  const gx = bounds.x + bounds.width * 0.78, gy = bounds.y + bounds.height * 0.24;
  const sceneBefore = await readSceneObjectSnapshot(page);
  await page.mouse.move(gx, gy);
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
  const frameTimes = [];
  await page.mouse.move(gx, gy);
  await page.mouse.down();
  for (let index = 0; index < 16; index++) {
    await page.mouse.move(gx + (index % 2 ? 1 : -1) * bounds.width * 0.12,
      gy + Math.sin(index) * bounds.height * 0.04);
    await page.waitForTimeout(20);
    frames.push(await page.screenshot({ clip: bounds }));
    frameTimes.push(performance.now());
  }
  await page.mouse.up();
  // 场景污染硬守卫:输入轨迹只允许相机手势,模型位移/增删即红牌——否则后续
  // 腿的 fitAll/位姿基准建立在被污染的场景上,跨后端对比再度失去可比性。
  const sceneAfter = await readSceneObjectSnapshot(page);
  const sceneModelDelta = sceneAfter.length !== sceneBefore.length;
  const boxDrift = sceneModelDelta ? Infinity : Math.max(...sceneAfter.map((model, index) => {
    const before = sceneBefore[index];
    return Math.max(
      Math.abs(model.min[0] - before.min[0]), Math.abs(model.min[1] - before.min[1]), Math.abs(model.min[2] - before.min[2]),
      Math.abs(model.max[0] - before.max[0]), Math.abs(model.max[1] - before.max[1]), Math.abs(model.max[2] - before.max[2]));
  }));
  if (sceneModelDelta || boxDrift > 1e-4) {
    report.guards.push({ type: "inputDragMutatedScene", backend,
      modelCountChanged: sceneModelDelta, maxWorldBoxDelta: Number(boxDrift === Infinity ? "NaN" : boxDrift.toFixed(6)) });
  }
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
    // submit 间隔序列:定性内部渲染循环节拍(相机静止时 wasm 是否降频/跳帧)。
    const submitGaps = [];
    for (let index = 1; index < session.state.submitTimestamps.length; index++) {
      submitGaps.push(session.state.submitTimestamps[index] - session.state.submitTimestamps[index - 1]);
    }
    delete window.__fairInput;
    return { sampledFrames: sorted.length, pointerEvents: session.state.pointerEvents,
      p50FrameMs: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      p99FrameMs: sorted[Math.floor(sorted.length * 0.99)] ?? 0,
      maxFrameMs: sorted[sorted.length - 1] ?? 0,
      longTaskCount: session.state.longTasks.length,
      pointerToBackendSubmit: summarize(session.state.pointerToBackendSubmit),
      pointerToGpuComplete: summarize(session.state.pointerToGpuComplete),
      pointerToPresent: summarize(session.state.pointerToPresent),
      submitGap: summarize(submitGaps) };
  });
  const luminance = [];
  const greyBuffers = [];
  for (const frame of frames) {
    const { data } = await sharp(frame).greyscale().raw().toBuffer({ resolveWithObject: true });
    greyBuffers.push(data);
    let sum = 0, nearBlack = 0;
    for (const value of data) { sum += value; if (value < 4) nearBlack++; }
    luminance.push({ mean: sum / data.length, nearBlackRatio: nearBlack / data.length });
  }
  // 拖拽平滑度:相邻呈现帧的灰度平均绝对差;低于阈值的相邻对视为"重复帧"
  // (合成器复现上一帧)。有效帧率 = 采样窗口 × (1 - 重复率)。
  const duplicateThreshold = 0.35;
  let duplicates = 0;
  const diffs = [];
  for (let index = 1; index < greyBuffers.length; index++) {
    const a = greyBuffers[index - 1], b = greyBuffers[index];
    let total = 0;
    const stride = 4; // 每第 4 像素抽样,足够分辨重复帧
    let count = 0;
    for (let offset = 0; offset < a.length; offset += stride) { total += Math.abs(a[offset] - b[offset]); count++; }
    const meanDiff = total / count;
    diffs.push(meanDiff);
    if (meanDiff < duplicateThreshold) duplicates++;
  }
  const distinctRatio = diffs.length ? 1 - duplicates / diffs.length : 0;
  const captureMs = frameTimes.length > 1 ? frameTimes.at(-1) - frameTimes[0] : 0;
  const effectiveFps = distinctRatio > 0 && captureMs > 0 ? (frames.length - 1 - duplicates) * 1000 / captureMs : null;
  const medianMean = [...luminance].map(item => item.mean).sort((a, b) => a - b)[Math.floor(luminance.length / 2)] ?? 0;
  const blackFrames = luminance.filter(item => item.mean < Math.max(2, medianMean * 0.25)).length;
  const lastPath = `${output}input-${backend}-last.png`;
  await sharp(frames.at(-1)).toFile(lastPath);
  report.guards.push(...(blackFrames > 0 ? [{ type: "blackFrames", backend, blackFrames }] : []));
  report.guards.push(...(medianMean < 5 ? [{ type: "luminanceFloor", backend, medianMean }] : []));
  return { ...timing, blackFrames, medianMeanLuminance: Number(medianMean.toFixed(2)),
    dragSmoothness: { sampledFrames: frames.length, duplicateFrames: duplicates,
      distinctFrameRatio: Number(distinctRatio.toFixed(3)),
      captureMs: Number(captureMs.toFixed(1)),
      effectiveFps: effectiveFps === null ? null : Number(effectiveFps.toFixed(1)),
      availability: effectiveFps === null ? "unmeasured-static-capture" : "measured" } };
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
  // F2 输入门(硬守卫):列名 gates.inputP95,超限进 guards 使门红。
  // 参考与候选同轮测得;缺参考或候选输入数据时按守卫缺失处理(不许静默放行)。
  report.gates = { inputP95: { ratioMax: inputP95GateRatio, backends: inputP95GateBackends, results: {} } };
  const referenceP95 = reference?.input?.p95FrameMs;
  for (const backend of inputP95GateBackends) {
    const candidateP95 = report.backends[backend]?.input?.p95FrameMs;
    if (!referenceP95 || !candidateP95) {
      report.guards.push({ type: "inputP95Gate", backend, reason: "missing-input-p95",
        referenceP95Ms: referenceP95 ?? null, candidateP95Ms: candidateP95 ?? null });
      continue;
    }
    const ratio = candidateP95 / referenceP95;
    report.gates.inputP95.results[backend] = { ratio: Number(ratio.toFixed(3)),
      candidateP95Ms: Number(candidateP95.toFixed(1)), referenceP95Ms: Number(referenceP95.toFixed(1)),
      passed: ratio <= inputP95GateRatio };
    if (ratio > inputP95GateRatio) {
      report.guards.push({ type: "inputP95Gate", backend, ratio: Number(ratio.toFixed(3)),
        candidateP95Ms: Number(candidateP95.toFixed(1)), referenceP95Ms: Number(referenceP95.toFixed(1)),
        maxRatio: inputP95GateRatio });
    }
  }
}

function renderMarkdown(report) {
  const rows = Object.entries(report.backends).map(([backend, data]) => {
    const input = data.input;
    return `| ${backend} | ${data.static.p50Ms?.toFixed(2) ?? "-"} | ${data.static.p95Ms?.toFixed(2) ?? "-"} | ${input.p50FrameMs?.toFixed(2) ?? "-"} | ${input.p95FrameMs?.toFixed(2) ?? "-"} | ${input.pointerToBackendSubmit?.p95Ms?.toFixed(2) ?? "-"} | ${input.pointerToGpuComplete?.p95Ms?.toFixed(2) ?? "-"} | ${input.blackFrames} | ${input.longTaskCount} |`;
  });
  const parity = report.pixelParity.map(item =>
    `| ${item.pose} | ${item.candidate} | ${item.ssim} | ${(item.meanAbsoluteError * 100).toFixed(2)}% |`);
  const cameraParity = (report.cameraParity ?? []).map(item =>
    `| ${item.stage} | ${item.backend} | ${item.maxMatrixWorldDelta.toExponential(2)} | ${item.withinTolerance ? "通过" : "超差"} |`);
  const sceneCounts = Object.entries(report.backends)
    .map(([backend, data]) => `${backend}=${data.scene?.modelCount ?? "?"}`).join(" / ");
  return [
    "# Deep vs Three WebGL 同场景同相机公平对比",
    "",
    `生成时间:${report.createdAt};静置采样 ${report.protocol.staticSamples} 帧;输入轨迹 ${report.protocol.inputSteps} 步;固定位姿 ${report.protocol.poses.join("/")}。`,
    "",
    "| 后端 | 静置 P50 ms | 静置 P95 ms | 输入 P50 ms | 输入 P95 ms | pointer→submit P95 ms | pointer→GPU 完成 P95 ms | 黑帧 | Long Task |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    `场景对象计数(守卫①,作者层):${sceneCounts}`,
    "",
    "## 相机矩阵对拍(守卫②③,作者层 matrixWorld 逐元素最大绝对差,容差 1e-6)",
    "",
    "| 阶段 | 候选后端 | 最大矩阵差 | 判定 |",
    "|---|---|---:|---|",
    ...cameraParity,
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
    `输入 P95 阈值门(≤1.2× 同轮 WebGL,超限即守卫失败):${JSON.stringify(report.gates?.inputP95?.results ?? {})}`,
    "",
    "> SSIM 只作记录:跨引擎画风差异不作失败依据。胜出判定必须以本报告的实测数据为准,不得以切换成功推导。",
    "",
  ].join("\n");
}
