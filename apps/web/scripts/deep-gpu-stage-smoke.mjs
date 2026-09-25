import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const source = `/@fs/${fileURLToPath(new URL("../../../packages/deep-engine/src/webgpu/index.ts", import.meta.url)).replaceAll("\\", "/")}`;
const output = fileURLToPath(new URL("../../../test-output/deep-gpu-stage-smoke/", import.meta.url));
await mkdir(output, { recursive: true });

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 540 } });
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${origin}/dev/engine.html`, { waitUntil: "domcontentloaded" });
  const result = await page.evaluate(async sourceUrl => {
    const { PbrRenderer } = await import(sourceUrl);
    const canvas = document.createElement("canvas");
    canvas.dataset.gpuStageSmoke = "true";
    canvas.width = 640; canvas.height = 360;
    canvas.style.cssText = "position:fixed;inset:80px auto auto 20px;width:640px;height:360px";
    document.body.append(canvas);
    const submissions = [];
    const originalSubmit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (commandBuffers) {
      submissions.push(commandBuffers.length);
      return originalSubmit.call(this, commandBuffers);
    };
    let renderer;
    let retained = false;
    try {
      renderer = await PbrRenderer.create(canvas, navigator.gpu, AbortSignal.timeout(60_000));
      await renderer.setInstancesValidated(new Float32Array([
        0, 0, 0, 0.55, 0.8, 0.3, 0.2, 0.1, 0.7, 0, 0, 0,
      ]));
      const view = { width: 640, height: 360, pixelRatio: 1,
        eye: [0, 1.2, 3], target: [0, 0, 0], up: [0, 1, 0], extent: 3,
        verticalFovRadians: 1, near: 0.1, far: 20, background: [0.03, 0.05, 0.07], floor: [0.02, 0.03, 0.04],
        exposure: 1, roughness: 0.8 };
      await renderer.validateFrame(view);
      submissions.length = 0;
      renderer.setDiagnosticsSampling(true);
      const frames = [];
      for (let index = 0; index < 12; index++) {
        const frame = renderer.render(view);
        if (!frame) throw new Error("No submitted PBR frame");
        frames.push(frame.frame);
        await renderer.session.device.queue.onSubmittedWorkDone();
      }
      const timings = await renderer.gpuTimer.collect(frames[0], frames.at(-1));
      globalThis.__gpuStageSmokeCleanup = () => renderer.dispose();
      retained = true;
      return { timestampSupported: renderer.gpuTimer.supported,
        frames, submissions, timings, telemetry: renderer.performanceTelemetry.snapshot(),
        diagnostics: renderer.session.diagnostics.map(item => `${item.kind}: ${item.message}`),
        timerDiagnostics: renderer.gpuTimer.diagnostics };
    } finally {
      GPUQueue.prototype.submit = originalSubmit;
      if (!retained) renderer?.dispose();
    }
  }, source);
  await page.locator('canvas[data-gpu-stage-smoke="true"]').screenshot({ path: `${output}frame.png` });
  await page.evaluate(() => globalThis.__gpuStageSmokeCleanup?.());
  assert.equal(pageErrors.length, 0, `Browser errors: ${pageErrors.join("; ")}`);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.timerDiagnostics, []);
  assert.ok(result.submissions.length >= result.frames.length);
  assert.ok(result.submissions.every(count => count === 1), `Expected one buffer per static frame: ${result.submissions}`);
  if (result.timestampSupported) {
    assert.ok(result.timings.length > 0, "Supported GPU yielded no timing samples");
    assert.ok(result.timings.some(timing => timing.stages && Object.values(timing.stages).every(Number.isFinite)),
      "Supported GPU yielded no coarse stage samples");
  }
  await writeFile(`${output}report.json`, JSON.stringify({ ...result, pageErrors, passed: true }, null, 2));
  console.log(JSON.stringify({ frames: result.frames.length, submissions: result.submissions,
    timestampSupported: result.timestampSupported, timingSamples: result.timings.length,
    stages: result.telemetry.stages, passed: true }));
} finally { await browser.close(); }
