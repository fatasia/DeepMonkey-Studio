import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import sharp from "sharp";

const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const route = `/studio/${sceneId}?project=${projectId}`;
const allowSaveConflict = process.env.STUDIO_ALLOW_SAVE_CONFLICT === "1";
const output = fileURLToPath(new URL("../../../test-output/engine-switch-integration/", import.meta.url));
await mkdir(output, { recursive: true });

const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
assert.equal(login.status, 200, `Studio login failed: HTTP ${login.status}`);
const { token } = await login.json();
assert.ok(token, "Studio login did not return a token");

const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});

const report = {
  schema: "deep-monkey.engine-switch-integration.v1",
  createdAt: new Date().toISOString(),
  route,
  cycle: [],
  save: {},
  restoration: {},
  failureFallback: {},
  timings: {},
  interaction: {},
  errors: [],
  warnings: [],
  responses5xx: [],
  screenshots: [],
};

try {
  await runSwitchCycle();
  await runFailureFallback();
  assert.deepEqual(report.responses5xx, [], `HTTP 5xx observed: ${JSON.stringify(report.responses5xx)}`);
  assert.deepEqual(report.errors, [], `unexpected browser errors: ${JSON.stringify(report.errors)}`);
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  report.passed = false;
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));

async function runSwitchCycle() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ token }) => {
    localStorage.setItem("bim-studio-auth-token", token);
    localStorage.setItem("bim-studio.renderer-backend", "webgl");
    const reactProfile = { commits: [] };
    let rendererId = 0;
    globalThis.__engineReactProfile = reactProfile;
    globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject(renderer) { const id = ++rendererId; this.renderers.set(id, renderer); return id; },
      onCommitFiberRoot(_id, root) {
        reactProfile.commits.push({ at: performance.now(), durationMs: root?.current?.actualDuration ?? 0 });
      },
      onCommitFiberUnmount() {},
    };
    const encoderPrototype = globalThis.GPUCommandEncoder?.prototype;
    if (encoderPrototype) {
      const beginRenderPass = encoderPrototype.beginRenderPass;
      encoderPrototype.beginRenderPass = function diagnosticRenderPass(descriptor) {
        try { return beginRenderPass.call(this, descriptor); }
        catch (error) { throw new Error(`[${descriptor?.label ?? "unlabelled render pass"}] ${error instanceof Error ? error.message : String(error)}`); }
      };
    }
  }, { token });
  const page = await context.newPage();
  observePage(page, "cycle");
  page.setDefaultTimeout(45_000);
  await page.goto(`${webOrigin}${route}`, { waitUntil: "domcontentloaded" });
  const author = page.locator(".viewport canvas:not([data-renderer-backend])").first();
  await author.waitFor({ state: "visible" });
  await page.waitForTimeout(1_500);

  await openRendererDialog(page);
  await recordBackend(page, "webgl", "cycle-webgl-1280.png");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const bounds = await author.boundingBox();
  assert.ok(bounds && bounds.width > 100 && bounds.height > 100, "author input canvas has no usable bounds");
  report.interaction.webgl = await measureInteraction(page, bounds, "webgl");
  await page.waitForTimeout(800);
  await openRendererDialog(page);

  const webGpuStartedAt = Date.now();
  await page.evaluate(() => performance.clearMarks());
  await page.getByRole("button", { name: "启用 Deep WebGPU Beta", exact: true }).click();
  await waitForPresentedCanvas(page, "deep-webgpu");
  report.timings.webgpuSwitchMs = Date.now() - webGpuStartedAt;
  report.timings.webgpuPhases = await switchPhases(page, "deep-webgpu");
  await recordBackend(page, "webgpu", "cycle-webgpu-1280.png");

  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const beforeEdit = await page.screenshot();
  report.interaction.webgpu = await measureInteraction(page, bounds, "webgpu");
  // Orbit is a viewport input, not a scene-object mutation. Exercise the real explicit
  // save action so the camera snapshot is persisted without making every pointer move
  // invalidate the top-level React tree or manufacture a scene revision.
  const saved = page.waitForResponse(response => response.request().method() === "PUT"
    && response.url().includes(`/api/projects/${projectId}/scenes/${sceneId}`), { timeout: 20_000 });
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  const saveResponse = await saved;
  assert.ok(saveResponse.ok() || (allowSaveConflict && saveResponse.status() === 409), `scene save failed: HTTP ${saveResponse.status()}`);
  if (allowSaveConflict && saveResponse.status() === 409) {
    report.errors = report.errors.filter(entry => !entry.text.includes("409 (Conflict)"));
  }
  await page.waitForTimeout(500);
  const afterEdit = await page.screenshot({ path: `${output}cycle-webgpu-after-edit.png` });
  report.screenshots.push("cycle-webgpu-after-edit.png");
  report.save = {
    method: saveResponse.request().method(),
    status: saveResponse.status(),
    url: saveResponse.url(),
    frameChanged: !beforeEdit.equals(afterEdit),
    beforeHash: sha256(beforeEdit),
    afterHash: sha256(afterEdit),
    camera: saveResponse.request().postDataJSON()?.camera ?? null,
  };
  assert.equal(report.save.frameChanged, true, "camera edit did not change the presented frame");

  await openRendererDialog(page);
  const wasmStartedAt = Date.now();
  await page.evaluate(() => performance.clearMarks());
  await page.getByRole("button", { name: "启用 Deep WASM", exact: true }).click();
  await waitForPresentedCanvas(page, "deep-wasm");
  report.timings.wasmSwitchMs = Date.now() - wasmStartedAt;
  report.timings.wasmPhases = await switchPhases(page, "deep-wasm");
  report.timings.wasmResources = await page.evaluate(() => performance.getEntriesByType("resource")
    .filter(entry => entry.name.includes("/engine-wasm/"))
    .map(entry => ({ name: entry.name, durationMs: entry.duration, transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize })));
  await page.locator('.viewport canvas[data-renderer-backend="deep-webgpu"]').waitFor({ state: "detached" });
  await recordBackend(page, "wasm", "cycle-wasm-1280.png");
  report.interaction.wasm = await measureInteraction(page, bounds, "wasm");

  const webGlStartedAt = Date.now();
  await page.getByRole("button", { name: "切换到兼容模式", exact: true }).click();
  await page.waitForFunction(() => {
    const authorCanvas = document.querySelector(".viewport canvas:not([data-renderer-backend])");
    const wasmCanvas = document.querySelector('.viewport canvas[data-renderer-backend="deep-wasm"]');
    return authorCanvas && getComputedStyle(authorCanvas).opacity === "1"
      && (!wasmCanvas || getComputedStyle(wasmCanvas).opacity === "0");
  });
  report.timings.webglReturnMs = Date.now() - webGlStartedAt;
  await recordBackend(page, "webgl", "cycle-return-webgl-1280.png");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible" });
  await page.waitForTimeout(1_200);
  const recovery = page.getByRole("dialog", { name: "恢复未保存工作", exact: true });
  if (await recovery.isVisible().catch(() => false)) {
    await recovery.getByRole("button", { name: "稍后处理", exact: true }).click();
  }
  report.restoration = await page.evaluate(() => ({
    preference: localStorage.getItem("bim-studio.renderer-backend"),
    authorOpacity: getComputedStyle(document.querySelector(".viewport canvas:not([data-renderer-backend])")).opacity,
    visibleCandidates: [...document.querySelectorAll(".viewport canvas[data-renderer-backend]")]
      .filter(canvas => getComputedStyle(canvas).opacity === "1")
      .map(canvas => canvas.dataset.rendererBackend),
  }));
  assert.deepEqual(report.restoration, { preference: "webgl", authorOpacity: "1", visibleCandidates: [] });

  await page.setViewportSize({ width: 480, height: 800 });
  await openRendererDialog(page);
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  const layout = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: innerWidth, height: innerHeight, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
  });
  layout.insideViewport = layout.left >= -1 && layout.right <= layout.width + 1
    && layout.top >= -1 && layout.bottom <= layout.height + 1;
  report.restoration.mobileDialog = layout;
  assert.equal(layout.insideViewport, true, `renderer dialog clipped after restoration: ${JSON.stringify(layout)}`);
  await page.screenshot({ path: `${output}cycle-restored-webgl-480.png` });
  report.screenshots.push("cycle-restored-webgl-480.png");
  await context.close();
}

async function runFailureFallback() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ token }) => {
    localStorage.setItem("bim-studio-auth-token", token);
    localStorage.setItem("bim-studio.renderer-backend", "webgl");
  }, { token });
  await context.route("**/engine-wasm/deep_engine_wasm.js", route => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: 'throw new Error("Injected engine-switch E2E module failure");',
  }));
  const page = await context.newPage();
  observePage(page, "failure-fallback", ["Injected engine-switch E2E module failure"]);
  page.setDefaultTimeout(45_000);
  await page.goto(`${webOrigin}${route}`, { waitUntil: "domcontentloaded" });
  await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible" });
  await openRendererDialog(page);
  await page.getByRole("button", { name: "启用 Deep WASM", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  await dialog.getByText("切换未完成", { exact: false }).waitFor();
  report.failureFallback = await page.evaluate(() => ({
    preference: localStorage.getItem("bim-studio.renderer-backend"),
    authorOpacity: getComputedStyle(document.querySelector(".viewport canvas:not([data-renderer-backend])")).opacity,
    visibleCandidates: [...document.querySelectorAll(".viewport canvas[data-renderer-backend]")]
      .filter(canvas => getComputedStyle(canvas).opacity === "1")
      .map(canvas => canvas.dataset.rendererBackend),
    status: document.querySelector(".renderer-switch-status")?.textContent,
  }));
  assert.equal(report.failureFallback.preference, "webgl");
  assert.equal(report.failureFallback.authorOpacity, "1");
  assert.deepEqual(report.failureFallback.visibleCandidates, []);
  assert.match(report.failureFallback.status ?? "", /切换未完成/);
  await page.screenshot({ path: `${output}failure-fallback-webgl-1280.png` });
  report.screenshots.push("failure-fallback-webgl-1280.png");
  await context.close();
}

async function openRendererDialog(page) {
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  if (await dialog.isVisible().catch(() => false)) return dialog;
  await page.getByLabel("更多场景工具", { exact: true }).click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  await dialog.waitFor({ state: "visible" });
  await dialog.getByRole("button", { name: /启用 Deep|正在使用|切换到兼容模式/ }).first().waitFor();
  return dialog;
}

async function waitForPresentedCanvas(page, backend) {
  await page.locator(`.viewport canvas[data-renderer-backend="${backend}"]`).waitFor({ state: "attached" });
  await page.waitForFunction(expected => {
    const canvas = document.querySelector(`.viewport canvas[data-renderer-backend="${expected}"]`);
    const failed = document.querySelector(".renderer-switch-status.failed");
    return failed || (canvas && getComputedStyle(canvas).opacity === "1" && getComputedStyle(canvas).visibility === "visible");
  }, backend, { timeout: 120_000 });
  const failedStatus = page.locator(".renderer-switch-status.failed");
  const failure = await failedStatus.count() ? await failedStatus.textContent() : null;
  if (failure) {
    const state = await page.evaluate(() => ({
      status: document.querySelector(".renderer-switch-status")?.textContent,
      canvases: [...document.querySelectorAll(".viewport canvas")].map(canvas => ({
        backend: canvas.dataset.rendererBackend ?? "author-webgl",
        opacity: getComputedStyle(canvas).opacity,
        visibility: getComputedStyle(canvas).visibility,
      })),
    }));
    throw new Error(`${backend} switch failed: ${failure}; ${JSON.stringify(state)}`);
  }
  const preference = backend === "deep-webgpu" ? "webgpu" : backend === "deep-wasm" ? "wasm" : "webgl";
  await page.waitForFunction(({ expected, preference }) => {
    const canvas = document.querySelector(`.viewport canvas[data-renderer-backend="${expected}"]`);
    return localStorage.getItem("bim-studio.renderer-backend") === preference
      && canvas && getComputedStyle(canvas).opacity === "1";
  }, { expected: backend, preference }, { timeout: 120_000, polling: 100 });
  await page.waitForTimeout(300);
}

async function recordBackend(page, backend, screenshot) {
  const state = await page.evaluate(() => ({
    preference: localStorage.getItem("bim-studio.renderer-backend"),
    canvases: [...document.querySelectorAll(".viewport canvas")].map(canvas => ({
      backend: canvas.dataset.rendererBackend ?? "author-webgl",
      opacity: getComputedStyle(canvas).opacity,
      visibility: getComputedStyle(canvas).visibility,
      pointerEvents: getComputedStyle(canvas).pointerEvents,
      width: canvas.width,
      height: canvas.height,
      cssWidth: canvas.getBoundingClientRect().width,
      cssHeight: canvas.getBoundingClientRect().height,
    })),
  }));
  assert.equal(state.preference, backend, `${backend} preference was not committed`);
  const expectedCanvas = backend === "webgl" ? "author-webgl" : backend === "webgpu" ? "deep-webgpu" : "deep-wasm";
  assert.equal(state.canvases.findLast(item => item.backend === expectedCanvas)?.opacity, "1",
    `${backend} did not own presentation: ${JSON.stringify(state.canvases)}`);
  const expectedAuthorPointerEvents = backend === "webgl" ? "auto" : "none";
  assert.equal(state.canvases.find(item => item.backend === "author-webgl")?.pointerEvents, expectedAuthorPointerEvents,
    backend === "webgl" ? "author canvas lost input ownership" : "author canvas did not hand input to the presentation backend");
  const authorCanvas = state.canvases.find(item => item.backend === "author-webgl");
  const presentationCanvas = state.canvases.findLast(item => item.backend === expectedCanvas);
  assert.ok(authorCanvas && presentationCanvas, `${backend} canvas inventory is incomplete`);
  if (backend !== "webgl") {
    assert.equal(presentationCanvas.pointerEvents, "auto", `${backend} presentation canvas did not take input ownership`);
  }
  assert.ok(Math.abs(presentationCanvas.width - authorCanvas.width) <= 1
    && Math.abs(presentationCanvas.height - authorCanvas.height) <= 1,
  `${backend} backing surface differs from the author surface: ${JSON.stringify({ authorCanvas, presentationCanvas })}`);
  assert.ok(Math.abs(presentationCanvas.cssWidth - authorCanvas.cssWidth) <= 0.5
    && Math.abs(presentationCanvas.cssHeight - authorCanvas.cssHeight) <= 0.5,
  `${backend} CSS viewport differs from the author surface: ${JSON.stringify({ authorCanvas, presentationCanvas })}`);
  report.cycle.push({ backend, preference: state.preference, canvases: state.canvases });
  await page.screenshot({ path: `${output}${screenshot}` });
  report.screenshots.push(screenshot);
}

function observePage(page, phase, allowedErrors = []) {
  page.on("pageerror", error => {
    if (!allowedErrors.some(fragment => error.message.includes(fragment))) {
      report.errors.push({ phase, type: "pageerror", text: error.message });
    }
  });
  page.on("console", message => {
    const entry = { phase, type: message.type(), text: message.text() };
    if (message.type() === "error" && !(allowSaveConflict && message.text().includes("409 (Conflict)"))
        && !allowedErrors.some(fragment => message.text().includes(fragment))) report.errors.push(entry);
    else if (message.type() === "warning") report.warnings.push(entry);
  });
  page.on("response", response => {
    if (response.status() >= 500) report.responses5xx.push({ phase, status: response.status(), url: response.url() });
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function switchPhases(page, prefix) {
  const marks = await page.evaluate(prefix => performance.getEntriesByType("mark")
    .filter(entry => entry.name.startsWith(`${prefix}:`))
    .map(entry => ({ name: entry.name, startTime: entry.startTime })), prefix);
  const first = marks[0]?.startTime ?? 0;
  return marks.map(mark => ({ phase: mark.name.slice(prefix.length + 1), elapsedMs: Math.round(mark.startTime - first) }));
}

async function measureInteraction(page, bounds, backend) {
  await page.evaluate(() => {
    const reactStart = globalThis.__engineReactProfile?.commits.length ?? 0;
    const state = { intervals: [], longTasks: [], pointerEvents: 0, active: true, last: performance.now(),
      pointerSerial: 0, pointerAt: 0, authorSerial: 0, backendSerial: 0, gpuFenceSerial: 0,
      pointerToAuthorFrame: [], pointerToBackendSubmit: [], pointerToGpuComplete: [] };
    const tick = now => {
      if (!state.active) return;
      state.intervals.push(now - state.last); state.last = now;
      if (state.pointerSerial !== state.authorSerial) {
        state.authorSerial = state.pointerSerial;
        // The rAF callback timestamp is the frame start and may precede a
        // pointer event delivered in that frame. Use observation time so this
        // measures event -> next author-frame callback without negative values.
        state.pointerToAuthorFrame.push(performance.now() - state.pointerAt);
      }
      requestAnimationFrame(tick);
    };
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
    });
    try { observer.observe({ type: "longtask", buffered: false }); } catch { /* unsupported browser */ }
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
    window.__engineInteraction = { state, observer, pointer, restores, reactStart };
    requestAnimationFrame(tick);
  });
  const x = bounds.x + bounds.width * 0.5, y = bounds.y + bounds.height * 0.5;
  await page.mouse.move(x, y); await page.mouse.down();
  for (let index = 0; index < 120; index++) {
    const phase = index / 119 * Math.PI * 4;
    await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18,
      y + Math.cos(phase * 0.5) * bounds.height * 0.08);
    await page.waitForTimeout(16);
  }
  await page.mouse.up(); await page.waitForTimeout(100);
  const timing = await page.evaluate(() => {
    const session = window.__engineInteraction;
    session.state.active = false; session.observer.disconnect();
    document.removeEventListener("pointermove", session.pointer, true);
    for (const restore of session.restores) restore();
    const sorted = session.state.intervals.slice(1).sort((a, b) => a - b);
    const percentile = value => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
    const summarize = values => {
      const ordered = [...values].sort((a, b) => a - b);
      const at = value => ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * value))] ?? null;
      return { samples: ordered.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99) };
    };
    const reactCommits = (globalThis.__engineReactProfile?.commits ?? []).slice(session.reactStart);
    delete window.__engineInteraction;
    return { sampledFrames: sorted.length, pointerEvents: session.state.pointerEvents,
      p50FrameMs: percentile(0.5), p95FrameMs: percentile(0.95), p99FrameMs: percentile(0.99),
      maxFrameMs: sorted.at(-1) ?? 0, longTaskCount: session.state.longTasks.length,
      longTaskTotalMs: session.state.longTasks.reduce((sum, value) => sum + value, 0),
      pointerToAuthorFrame: summarize(session.state.pointerToAuthorFrame),
      pointerToBackendSubmit: summarize(session.state.pointerToBackendSubmit),
      pointerToGpuComplete: summarize(session.state.pointerToGpuComplete),
      react: { commits: reactCommits.length,
        totalActualDurationMs: reactCommits.reduce((sum, commit) => sum + commit.durationMs, 0),
        maxActualDurationMs: Math.max(0, ...reactCommits.map(commit => commit.durationMs)) } };
  });

  const frames = [];
  await page.mouse.move(x, y); await page.mouse.down();
  for (let index = 0; index < 16; index++) {
    await page.mouse.move(x + (index % 2 ? 1 : -1) * bounds.width * 0.12,
      y + Math.sin(index) * bounds.height * 0.04);
    await page.waitForTimeout(20);
    frames.push(await page.screenshot({ clip: bounds }));
  }
  await page.mouse.up();
  const luminance = [];
  for (const frame of frames) {
    const { data } = await sharp(frame).greyscale().raw().toBuffer({ resolveWithObject: true });
    let sum = 0, nearBlack = 0;
    for (const value of data) { sum += value; if (value < 4) nearBlack++; }
    luminance.push({ mean: sum / data.length, nearBlackRatio: nearBlack / data.length });
  }
  const medianMean = [...luminance].map(item => item.mean).sort((a, b) => a - b)[Math.floor(luminance.length / 2)] ?? 0;
  const blackFrames = luminance.filter(item => item.mean < Math.max(2, medianMean * 0.25)).length;
  await sharp(frames.at(-1)).toFile(`${output}interaction-${backend}-last.png`);
  report.screenshots.push(`interaction-${backend}-last.png`);
  return { ...timing, sampledCompositorFrames: luminance.length, blackFrames, medianMeanLuminance: medianMean,
    minMeanLuminance: Math.min(...luminance.map(item => item.mean)), maxNearBlackRatio: Math.max(...luminance.map(item => item.nearBlackRatio)) };
}
