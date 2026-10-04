import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { build } from "../packages/deep-engine/node_modules/esbuild/lib/main.js";

// AA-M2 a2c parity 探针运行器:bundle lab/a2cParityProbe.ts + playwright Chrome +
// 本地 http(与 bench-msaa1080p/gate-parity 同构)。采集 three(WebGL MSAA +
// SAMPLE_ALPHA_TO_COVERAGE)与 Deep(WebGPU MSAA4 主 pass a2c 管线变体)的
// sRGB 显示帧 PNG 与 RMSE 证据;无硬件 WebGPU 时 fail-closed。
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
  page.on("console", message => { if (message.type() === "error") console.log("[console]", message.text()); });
  page.on("pageerror", error => console.log("[pageerror]", error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => (await import("/probe.mjs")).runA2cParity());
  const a2cPipelines = await page.evaluate(() => window.__a2cPipelines);
  console.log("[a2c-parity] a2c pipeline descriptors created:", JSON.stringify(a2cPipelines));
  const saveDataUrl = async (dataUrl, file) =>
    writeFile(path.join(out, file), Buffer.from(String(dataUrl).split(",")[1], "base64"));
  await saveDataUrl(result.three, "a2c-parity-three.png");
  await saveDataUrl(result.deep, "a2c-parity-deep.png");
  const evidence = { probe: "a2c-parity", date: new Date().toISOString(), width: result.width, height: result.height,
    rmse: +result.rmse.toFixed(3), deepMsaa: result.deepMsaa, deepAlpha: result.deepAlpha,
    note: "three=WebGL MSAA + SAMPLE_ALPHA_TO_COVERAGE;deep=WebGPU MSAA4 main-pass alphaToCoverageEnabled variant. Hardware a2c dither matrices are unspecified; this is evidence capture, thresholds are deferred to the parity-gate merge." };
  await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("[a2c-parity] saved evidence:", JSON.stringify(evidence));
} finally {
  await browser?.close().catch(() => {});
  server.close();
}
