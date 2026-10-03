import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

/**
 * F1 coverage/receipt/readouts GPU 真机读数探针(量,非时——帧时测量被并行负载禁用)。
 * 验收点:
 *  1) 常规帧(不开 diagnostics/performanceTelemetry)每帧携带 frameGraphReceipt +
 *     frameExecutionCoverage + visibleDraws(缺口②/①/③ 的直接证据);
 *  2) 回执 samples 对已编码 pass 给 not-requested/deferred 原因,未编码 pass 给
 *     pass not encoded,未映射槽位给 pass 未纳入第一切片(不伪零);
 *  3) 同一静态场景多帧 coverage/executed/registered 读数稳定。
 * 用法:node f1-coverage-gpu-probe.mjs <roundTag>
 */
const round = process.argv[2] ?? "r1";
globalThis.__f1ProbeTiming = process.argv.includes("--timing");
const origin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const source = `/@fs/${fileURLToPath(new URL("../../../packages/deep-engine/src/webgpu/index.ts", import.meta.url)).replaceAll("\\", "/")}`;
const output = fileURLToPath(new URL("../../../test-output/f1-coverage-20261002/", import.meta.url));
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
  const result = await page.evaluate(async payload => {
    const { sourceUrl, withTiming } = payload;
    const { PbrRenderer } = await import(sourceUrl);
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 360;
    canvas.style.cssText = "position:fixed;inset:80px auto auto 20px;width:640px;height:360px";
    document.body.append(canvas);
    let renderer;
    try {
      renderer = await PbrRenderer.create(canvas, navigator.gpu, AbortSignal.timeout(60_000),
        withTiming ? { gpuPassTiming: true } : {});
      // 静态实例栅格:确定性 coverage/可见量读数的场景输入。
      const instances = [];
      for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
        instances.push(
          x * 1.2 - 1.8, 0.3, z * 1.2 - 1.8, 0.4, 0.8, 0.3, 0.2, 0.1, 0.7, 0, 0, 0);
      }
      await renderer.setInstancesValidated(new Float32Array(instances));
      const view = { width: 640, height: 360, pixelRatio: 1,
        eye: [0, 1.2, 3], target: [0, 0, 0], up: [0, 1, 0], extent: 3,
        verticalFovRadians: 1, near: 0.1, far: 20, background: [0.03, 0.05, 0.07], floor: [0.02, 0.03, 0.04],
        exposure: 1, roughness: 0.8 };
      const frames = [];
      // diagnostics 未开启:常规帧路径(缺口②的核心验收)。
      for (let index = 0; index < 8; index++) {
        const frame = renderer.render(view);
        if (!frame) throw new Error("No submitted PBR frame");
        const receipt = frame.frameGraphReceipt;
        const coverage = frame.frameExecutionCoverage;
        frames.push({
          frame: frame.frame,
          hasReceipt: receipt !== undefined,
          passOrderLength: receipt?.passOrder.length,
          executedMappedPassIds: receipt?.executedMappedPassIds,
          unmappedPassIds: receipt?.unmappedPassIds,
          sampleReasons: receipt?.samples.map(sample => `${sample.passChannel}: ${sample.availability}: ${sample.unavailableReason ?? ""}`),
          coverage: coverage ? { registered: coverage.registeredPassCount, mapped: coverage.mappedPassCount,
            executed: coverage.executedPassCount, notExecuted: coverage.notExecutedMappedPassIds,
            ratio: coverage.executedCoverageRatio, planHash: coverage.planHash } : undefined,
          visibleDraws: frame.visibleDraws,
          passTimingsAvailability: frame.gpuPassTimings?.availability,
          passTimingsMeasured: frame.gpuPassTimings?.passes?.length,
          drawCalls: frame.drawCalls, triangles: frame.triangles,
        });
        await renderer.session.device.queue.onSubmittedWorkDone();
      }
      globalThis.__f1CoverageCleanup = () => renderer.dispose();
      const timestampSupported = renderer.gpuTimer.supported;
      const performanceTelemetryOn = renderer.performanceTelemetry.enabled;
      renderer.dispose();
      return { timestampSupported, performanceTelemetryOn, frames };
    } catch (error) {
      try { renderer?.dispose(); } catch { /* 已释放 */ }
      throw error;
    }
  }, { sourceUrl: source, withTiming: globalThis.__f1ProbeTiming === true });
  await browser.close();
  const verdict = {
    round,
    pageErrors,
    timestampSupported: result.timestampSupported,
    performanceTelemetryOn: result.performanceTelemetryOn,
    everyFrameHasReceipt: result.frames.every(frame => frame.hasReceipt),
    everyFrameHasCoverage: result.frames.every(frame => frame.coverage !== undefined),
    everyFrameHasVisibleDraws: result.frames.every(frame => frame.visibleDraws !== undefined),
    last: result.frames.at(-1),
    frames: result.frames,
  };
  await writeFile(new URL(`file:///${output.replaceAll("\\", "/")}/gpu-readings-${round}.json`), JSON.stringify(verdict, null, 2));
  console.log(JSON.stringify({ round, pageErrors: pageErrors.length,
    timestampSupported: verdict.timestampSupported,
    performanceTelemetryOn: verdict.performanceTelemetryOn,
    everyFrameHasReceipt: verdict.everyFrameHasReceipt,
    everyFrameHasCoverage: verdict.everyFrameHasCoverage,
    everyFrameHasVisibleDraws: verdict.everyFrameHasVisibleDraws,
    lastFrame: verdict.last && { frame: verdict.last.frame, passOrderLength: verdict.last.passOrderLength,
      executed: verdict.last.coverage?.executed, registered: verdict.last.coverage?.registered,
      ratio: verdict.last.coverage?.ratio, visibleDraws: verdict.last.visibleDraws } }, null, 1));
} finally {
  await browser.close().catch(() => {});
}
