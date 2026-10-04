import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { build } from "../packages/deep-engine/node_modules/esbuild/lib/main.js";

// A2C-P1 A/B 取证运行器(2026-10-05):主 pass target0 格式 rgba16float(对照臂)vs
// rgba8unorm(实验臂),验证 D3D12/Dawn 对 float RT 的 a2c tier 差异 —— 即上一刀 P1 的
// "驱动接受 descriptor 但不按片元 alpha 生成掩码" 是否为 float RT 特有。
//
// 两臂复用**同一份** lab/a2cParityProbe.ts bundle(证据机制逐位同构,唯一变量是格式):
// 每臂一个全新 page,addInitScript 在任何模块求值之前写 globalThis 旗标
// (renderTargets.ts 的实验钩子白名单见该文件;生产代码从不写该全局)。
// 判据:A/B 生效 = rgba8unorm 臂 opaque 变体 targetRgb.edgePixels 从轮廓量级(636)
// 升到抖动量级(≥8*WIDTH)且 targetAlpha 仍非 opaque;不生效 = 证据链升级为
// "本机 D3D12 对 a2c 的更广泛限制",与格式无关。

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
const out = path.join(root, "test-output/a2c-format-ab");
await mkdir(out, { recursive: true });
const lightsHostPlugin = {
  name: "ab-lights-host",
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
const ARMS = [
  { arm: "float", hdrFormat: "rgba16float", override: undefined },
  { arm: "rgba8unorm", hdrFormat: "rgba8unorm", override: "rgba8unorm" },
];
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  const executablePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!existsSync(executablePath)) throw Error(`Chrome not found at ${executablePath}; set BIM_STUDIO_CHROME_PATH`);
  browser = await chromium.launch({ headless: true, executablePath, args: process.env.BIM_STUDIO_CHROME_ARGS?.split(" ").filter(Boolean) ?? [] });
  const evidence = { probe: "a2c-format-ab", date: new Date().toISOString(),
    userAgent: undefined, arms: {}, note: "Same probe bundle for both arms; the only variable is the main-pass target0 format (renderTargets experiment hook, init-script-injected before any module evaluation). A/B positive = rgba8unorm arm shows hardware coverage dither (targetRgb.edgePixels >= 8*WIDTH) while target alpha stays non-opaque; negative = the D3D12 a2c limitation is format-independent and the evidence chain escalates." };
  for (const { arm, override } of ARMS) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, reducedMotion: "reduce" });
    await page.addInitScript(a2cPipelineHook);
    if (override !== undefined) await page.addInitScript(
      format => { window.__deepEngineExperimentHdrFormat = format; }, override);
    page.on("console", message => { if (message.type() === "error") console.log(`[${arm}][console]`, message.text()); });
    page.on("pageerror", error => console.log(`[${arm}][pageerror]`, error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const result = await page.evaluate(async () => (await import("/probe.mjs")).runA2cParity());
    const a2cPipelines = await page.evaluate(() => window.__a2cPipelines);
    evidence.userAgent ??= await page.evaluate(() => navigator.userAgent);
    const saveDataUrl = async (dataUrl, file) =>
      writeFile(path.join(out, file), Buffer.from(String(dataUrl).split(",")[1], "base64"));
    const verdict = variant => ({
      rmse: +variant.rmse.toFixed(3), deepMsaa: variant.deepMsaa, mrt: variant.mrt,
      targetFormat: variant.targetFormat, presentAlpha: variant.presentAlpha,
      targetAlpha: variant.targetAlpha, targetRgb: variant.targetRgb, verdict: variant.verdict });
    evidence.arms[arm] = { override: override ?? null, a2cPipelineDescriptors: a2cPipelines,
      opaque: { alphaTest: result.opaque.alphaTest, ...verdict(result.opaque) },
      masked: { alphaTest: result.masked.alphaTest, ...verdict(result.masked) },
      singleTarget: { alphaTest: result.singleTarget.alphaTest, ...verdict(result.singleTarget) } };
    for (const variant of ["opaque", "masked", "singleTarget"]) {
      await saveDataUrl(result[variant].three, `a2c-format-ab-${arm}-three-${variant}.png`);
      await saveDataUrl(result[variant].deep, `a2c-format-ab-${arm}-deep-${variant}.png`);
    }
    console.log(`[a2c-format-ab] arm=${arm} opaque:`,
      JSON.stringify({ targetFormat: result.opaque.targetFormat, targetRgb: result.opaque.targetRgb,
        targetAlpha: result.opaque.targetAlpha, dither: result.opaque.verdict.hardwareCoverageDither }));
    await page.close();
  }
  await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("[a2c-format-ab] saved evidence:", path.join(out, "evidence.json"));
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
