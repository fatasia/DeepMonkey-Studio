import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// B2 MegaLights 生产全链渲染级 harness runner(headless Chrome WebGPU;惯例沿
// packages/deep-engine/scripts/megaLightsGpuTest.mjs + scripts/sdf-gi-gpu.mjs)。
//
// 生产保真:探针构造真 DeviceSession + 真 PbrRenderer(生产默认 features + MSAA4 +
// 完整后处理链)+ 生产 RenderPacket 批次 + RenderView 世界灯;MegaLights 四段经
// pbrRendererFrames 生产 dispatch 挂主 encoder;像素读回走 present-color 白名单读回链。
//
// 腿与门:
//   A  整帧 p95(墙钟 + GPU timestamp 双口径)@1920×1080 5000 动态点光,门 ≤20ms;
//   A2 同场景 megaLights=false 关臂(整帧 − A2 ≈ MegaLights 四段生产增量,如实分解);
//   B  像素正确性:灯可见/亮暗对照/无 NaN,1080p PNG 截图证据;
//   C  开关关逐位一致:40 灯(簇光预算内)双臂 present-color 逐字节对比;
//   D  预算降级真实触发:内部分辨率降档 + metrics 披露(提示)+ 降档帧 PNG;
//   D2 池容量 fail-closed:超 MAX_MEGA_LIGHTS 拒绝。
//
// 证据:test-output/megaLights-render-20261005/。
// 诚实条款:整帧口径含主帧全部 pass;若 >20ms,evidence 里 fullFrameNote 如实区分
// 「RIS 两趟 15.8ms(M2 口径)」与「整帧含主渲染 Xms」,不混报。

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = path.resolve(process.env.MEGALIGHTS_RENDER_OUTPUT_DIR
  ?? path.join(repoRoot, "test-output", "megaLights-render-20261005"));
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.MEGALIGHTS_RENDER_ATTEMPTS ?? 2);
const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

async function startServer(directory) {
  const { createServer } = await import("node:http");
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method !== "GET" || !["probe.html", "probe.bundle.mjs"].includes(name)) {
      response.writeHead(404).end(); return;
    }
    response.writeHead(200, { "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" })
      .end(await readFile(path.join(directory, name)));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runInBrowser(origin) {
  const require = createRequire(import.meta.url);
  const playwright = require("../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu", "--use-angle=default"] });
  const result = {};
  try {
    const page = await browser.newPage({ viewport: { width: 1940, height: 1120 } });
    page.setDefaultTimeout(900000); // 腿 A/B 首帧管线编译 + 130 帧计时远超 evaluate 缺省 30s。
    const pageErrors = [], consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message)));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    result.adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const evaluateLeg = async (name, timeout = 900000) => page.evaluate(async (legName) => {
      const module = await import("./probe.bundle.mjs");
      try { return { ok: true, result: await module[legName]() }; }
      catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error),
          stack: String(error instanceof Error ? error.stack ?? "" : "").slice(0, 4000) };
      }
    }, name, { timeout });
    // 顺序:A(开)→ A2(关臂)→ B(像素;画布留在页面)→ 截图 → C → D → D2。
    result.fullFrameOn = await evaluateLeg("runFullFrameOn");
    result.fullFrameOff = await evaluateLeg("runFullFrameOff");
    result.pixel = await evaluateLeg("runPixelCorrectness");
    // 像素腿渲染器保活中,画布仍持有最后呈现帧 —— 截图后立刻释放。
    result.pageScreenshot = (await page.screenshot({ type: "png" })).toString("base64");
    await page.evaluate(async () => {
      const module = await import("./probe.bundle.mjs");
      await module.releasePixelLeg();
    });
    result.bitwise = await evaluateLeg("runBitwiseOff");
    result.budget = await evaluateLeg("runBudgetDegradation");
    result.poolFailClosed = await evaluateLeg("runPoolFailClosed");
    result.pageErrors = pageErrors;
    result.consoleErrors = consoleErrors.slice(0, 16);
    return result;
  } finally { await browser.close(); }
}

function timingPass(timing, gateMs) {
  if (!timing || typeof timing.p95 !== "number") return { pass: false, reason: "no timing samples" };
  return { pass: timing.p95 <= gateMs, p95: timing.p95, gateMs };
}

function summarize(probe) {
  const on = probe.fullFrameOn?.result, off = probe.fullFrameOff?.result;
  const pixel = probe.pixel?.result, bitwise = probe.bitwise?.result;
  const budget = probe.budget?.result, pool = probe.poolFailClosed?.result;
  const wallGate = timingPass(on?.wall, 20);
  const gpuGate = timingPass(on?.gpuTimestamp?.p95 !== undefined ? on.gpuTimestamp : undefined, 20);
  const fullFramePass = wallGate.pass && gpuGate.pass;
  const fullFrameNote = fullFramePass
    ? "整帧(含主帧全部 pass)双口径 p95 均 ≤20ms。"
    : `整帧口径含主帧全部 pass(与 M2「RIS 两趟 p95=15.8ms」不同口径,不混报):`
      + ` 墙钟 p95=${on?.wall?.p95?.toFixed(1) ?? "n/a"}ms, GPU timestamp p95=`
      + `${on?.gpuTimestamp?.p95?.toFixed(1) ?? "n/a"}ms; MegaLights 四段生产增量 ≈ `
      + `整帧(on p95 ${on?.wall?.p95?.toFixed(1) ?? "n/a"} − 关臂 p95 ${off?.wall?.p95?.toFixed(1) ?? "n/a"})ms。`;
  return {
    fullFrame: {
      wall: on?.wall, gpuTimestamp: on?.gpuTimestamp, wallGate, gpuGate,
      offArmWall: off?.wall, offArmGpuTimestamp: off?.gpuTimestamp,
      incrementalMs: on?.wall?.p50 !== undefined && off?.wall?.p50 !== undefined
        ? { p50: on.wall.p50 - off.wall.p50, p95: on.wall.p95 - off.wall.p95 } : undefined,
      pass: fullFramePass, note: fullFrameNote,
    },
    pixel: pixel ? {
      gates: pixel.gates, litOverDark: pixel.litOverDark, litNearOverDarkNear: pixel.litNearOverDarkNear,
      meanLuminance: pixel.meanLuminance, litFraction: pixel.litFraction, nanPixels: pixel.nanPixels,
      megaLightsMetrics: pixel.megaLightsMetrics,
      pass: Object.values(pixel.gates ?? {}).every(Boolean),
    } : { pass: false },
    bitwise: bitwise ? { pass: bitwise.bitwiseIdentical === true,
      totalDiffBytes: bitwise.totalDiffBytes, perFrame: bitwise.perFrame } : { pass: false },
    budget: budget ? { gates: budget.gates, degradedFrames: budget.degradedFrames,
      finalScale: budget.finalScale, finalInternal: budget.finalInternal,
      pass: Object.values(budget.gates ?? {}).every(Boolean) } : { pass: false },
    poolFailClosed: pool ? { pass: pool.pass === true, threw: pool.threw } : { pass: false },
  };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "megalights-render-"));
  const require = createRequire(import.meta.url);
  const { build } = require("../packages/deep-engine/node_modules/esbuild");
  await build({ absWorkingDir: path.join(repoRoot, "packages/deep-engine"),
    entryPoints: ["lab/megaLightsRenderProbe.ts"], bundle: true, format: "esm", target: "es2022",
    outfile: path.join(bundleDirectory, "probe.bundle.mjs"), logLevel: "warning",
    conditions: ["development"] });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><meta charset="utf-8"><title>MegaLights render harness</title></head>`
    + `<body style="margin:0;background:#000"></body></html>`);
  let probe = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try { probe = await runInBrowser(origin); }
    catch (error) { probe = { error: String(error instanceof Error ? error.message : error) }; }
    finally { server.close(); }
    const legsHealthy = probe && ["fullFrameOn", "fullFrameOff", "pixel", "bitwise", "budget", "poolFailClosed"]
      .every(key => probe[key]?.ok === true);
    if (legsHealthy && !probe.pageErrors.length) break;
    if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe || probe.error) {
    console.error(JSON.stringify(probe));
    throw new Error("MegaLights render harness failed: " + String(probe?.error ?? "no result"));
  }
  await mkdir(outputDirectory, { recursive: true });
  // 像素帧(原增益 + 低增益结构)、降档帧 PNG + 页面截图落盘(截图证据)。
  for (const [name, leg, field] of [
    ["mega-pixel-1080p", probe.pixel, "pngDataUrl"],
    ["mega-pixel-1080p-structure", probe.pixel, "pngExposureDataUrl"],
    ["mega-budget-degraded", probe.budget, "pngDataUrl"]]) {
    const dataUrl = leg?.result?.[field];
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,")) {
      const bytes = Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64");
      await writeFile(path.join(outputDirectory, `${name}.png`), bytes);
      leg.result[`${field}Sha256`] = sha256(bytes);
      delete leg.result[field];
    }
  }
  if (probe.pageScreenshot) {
    const bytes = Buffer.from(probe.pageScreenshot, "base64");
    await writeFile(path.join(outputDirectory, "page-canvas-screenshot.png"), bytes);
    probe.pageScreenshotSha256 = sha256(bytes);
    delete probe.pageScreenshot;
  }
  const gates = summarize(probe);
  const legsOk = ["pixel", "bitwise", "budget", "poolFailClosed"].every(key => gates[key].pass);
  const success = legsOk && probe.pageErrors.length === 0 && gates.fullFrame.pass;
  const evidence = { action: "megalights-render-harness", date: new Date().toISOString(),
    adapter: probe.adapter, pageErrors: probe.pageErrors, consoleErrors: probe.consoleErrors,
    fullFrameOn: probe.fullFrameOn, fullFrameOff: probe.fullFrameOff, pixel: probe.pixel,
    bitwise: probe.bitwise, budget: probe.budget, poolFailClosed: probe.poolFailClosed, gates,
    gatesDeclared: { fullFrameP95Ms: 20, bitwiseIdentical: true, occlusionContrast: 1.5 },
    methodology: {
      wallClock: "renderer.render() → queue.onSubmittedWorkDone 每帧完成墙钟(含 CPU 编码 + 提交 + 全 GPU 执行)",
      gpuTimestamp: "gpuPassTiming 每帧全帧跨度(timestamp begin marker → end marker),滞后读回按实测帧收集",
      risTwoPassReference: "M2 口径(RIS 两趟,无主帧)p50=14.2/p95=15.8ms,见 test-output/ue-class-b2/megalights-m1/evidence.json",
    },
    success };
  const json = JSON.stringify(evidence, null, 2);
  await writeFile(path.join(outputDirectory, "acceptance.json"), json);
  console.log(`evidence: ${path.join(outputDirectory, "acceptance.json")} (sha256 ${sha256(Buffer.from(json)).slice(0, 16)}...)`);
  console.log(`fullFrame: ${JSON.stringify({ wall: gates.fullFrame.wall, gpu: gates.fullFrame.gpuTimestamp,
    offArmWall: gates.fullFrame.offArmWall, incrementalMs: gates.fullFrame.incrementalMs, pass: gates.fullFrame.pass })}`);
  console.log(`pixel: ${JSON.stringify(gates.pixel)}`);
  console.log(`bitwise: ${JSON.stringify(gates.bitwise)}`);
  console.log(`budget: ${JSON.stringify(gates.budget)}`);
  console.log(`poolFailClosed: ${JSON.stringify(gates.poolFailClosed)}`);
  console.log(`note: ${gates.fullFrame.note}`);
  for (const [key, leg] of Object.entries({ fullFrameOn: probe.fullFrameOn, fullFrameOff: probe.fullFrameOff,
    pixel: probe.pixel, bitwise: probe.bitwise, budget: probe.budget, poolFailClosed: probe.poolFailClosed })) {
    if (leg?.ok !== true) console.error(`leg ${key} not ok: ${JSON.stringify(leg).slice(0, 1200)}`);
  }
  if (!success) { console.error("MegaLights render harness FAILED (see gates above)"); process.exitCode = 1; }
}

await main();
