import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { build } from "../packages/deep-engine/node_modules/esbuild/lib/main.js";

// AA-M2 a2c parity / P1 取证运行器:bundle lab/a2cParityProbe.ts + playwright Chrome +
// 本地 http(与 bench-msaa1080p/gate-parity 同构)。采集 three(WebGL MSAA +
// SAMPLE_ALPHA_TO_COVERAGE)与 Deep(WebGPU MSAA4 主 pass a2c 管线变体)的 sRGB 显示帧
// PNG、主 pass opaque-hdr 读回统计与 RMSE 证据;无硬件 WebGPU 时 fail-closed。
//
// P1 descriptor 取证:上一刀的 requestDevice 对象包装钩子与 DeviceSession 冲突被剥掉;
// 本版改为 GPUDevice.prototype.createRenderPipeline(Async) 原型补丁,经 addInitScript
// 在任何页面脚本之前安装。DeviceSession 只持有 requestDevice 返回的真实 GPUDevice 实例、
// 从不替换原型,因此调用时解析必然经过补丁——包装层无法再把它 wrench 掉。钩子只读
// descriptor 并原样转发,失败静默,绝不影响渲染。
const a2cPipelineHook = () => {
  const records = [];
  const wrap = method => {
    const original = GPUDevice.prototype[method];
    if (typeof original !== "function") return;
    GPUDevice.prototype[method] = function (descriptor) {
      try {
        const targets = descriptor?.fragment?.targets;
        if (Array.isArray(targets) && targets.some(target => target?.alphaToCoverageEnabled === true)) {
          records.push({ method, label: String(descriptor.label ?? ""),
            sampleCount: descriptor.multisample?.count ?? 1,
            depthFormat: descriptor.depthStencil?.format ?? null,
            targets: targets.map(target => ({ format: String(target?.format),
              alphaToCoverageEnabled: target?.alphaToCoverageEnabled === true })) });
        }
      } catch { /* 取证钩子绝不干扰渲染 */ }
      return original.call(this, descriptor);
    };
  };
  wrap("createRenderPipeline");
  wrap("createRenderPipelineAsync");
  Object.defineProperty(window, "__a2cPipelines", { configurable: true, get: () => records });
};

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root, "test-output/a2c-parity");
await mkdir(out, { recursive: true });
const lightsHostPlugin = {
  name: "parity-lights-host",
  setup(builder) {
    builder.onResolve({ filter: /parityGateLightsHost/ },
      () => ({ path: path.join(root, "apps/web/src/viewer/studioDeepEnvironmentLights.ts") }));
  },
};
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/a2cParityProbe.ts")], outfile: path.join(out, "probe.mjs"),
  bundle: true, format: "esm", platform: "browser", conditions: ["development"], plugins: [lightsHostPlugin], logLevel: "error" });
const html = "<html><body style='margin:0'></body></html>";
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", request.url === "/probe.mjs" ? "text/javascript" : "text/html");
  response.end(request.url === "/probe.mjs" ? await readFile0() : html);
  async function readFile0() { return (await import("node:fs/promises")).readFile(path.join(out, "probe.mjs"), "utf8"); }
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  const executablePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!existsSync(executablePath)) throw Error(`Chrome not found at ${executablePath}; set BIM_STUDIO_CHROME_PATH`);
  browser = await chromium.launch({ headless: true, executablePath, args: process.env.BIM_STUDIO_CHROME_ARGS?.split(" ").filter(Boolean) ?? [] });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
  await page.addInitScript(a2cPipelineHook);
  page.on("console", message => { if (message.type() === "error") console.log("[console]", message.text()); });
  page.on("pageerror", error => console.log("[pageerror]", error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => (await import("/probe.mjs")).runA2cParity());
  const a2cPipelines = await page.evaluate(() => window.__a2cPipelines);
  console.log("[a2c-parity] a2c pipeline descriptors created:", JSON.stringify(a2cPipelines));
  const saveDataUrl = async (dataUrl, file) =>
    writeFile(path.join(out, file), Buffer.from(String(dataUrl).split(",")[1], "base64"));
  await saveDataUrl(result.opaque.three, "a2c-parity-three-opaque.png");
  await saveDataUrl(result.opaque.deep, "a2c-parity-deep-opaque.png");
  await saveDataUrl(result.masked.three, "a2c-parity-three-masked.png");
  await saveDataUrl(result.masked.deep, "a2c-parity-deep-masked.png");
  await saveDataUrl(result.singleTarget.three, "a2c-parity-three-single-target.png");
  await saveDataUrl(result.singleTarget.deep, "a2c-parity-deep-single-target.png");
  const verdict = variant => ({
    rmse: +variant.rmse.toFixed(3), deepMsaa: variant.deepMsaa, mrt: variant.mrt,
    presentAlpha: variant.presentAlpha, targetAlpha: variant.targetAlpha, targetRgb: variant.targetRgb,
    verdict: variant.verdict });
  const evidence = { probe: "a2c-parity", date: new Date().toISOString(), width: result.width, height: result.height,
    userAgent: await page.evaluate(() => navigator.userAgent),
    a2cPipelineDescriptors: a2cPipelines,
    opaque: { alphaTest: result.opaque.alphaTest, ...verdict(result.opaque) },
    masked: { alphaTest: result.masked.alphaTest, ...verdict(result.masked) },
    singleTarget: { alphaTest: result.singleTarget.alphaTest, ...verdict(result.singleTarget) },
    note: "three=WebGL MSAA + SAMPLE_ALPHA_TO_COVERAGE;deep=WebGPU MSAA4 main-pass alphaToCoverageEnabled variant. targetAlpha/targetRgb come from the opaque-hdr readback (main pass target0 resolve, before the present chain); presentAlpha from the actual swapchain. Hardware a2c dither matrices are unspecified; this is evidence capture, thresholds are deferred to the parity-gate merge." };
  await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("[a2c-parity] saved evidence:", JSON.stringify(evidence));
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
