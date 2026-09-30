import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const visual = process.env.C18_GATE_MODE === "visual";
const out = path.join(root, "test-output/i-series-0930", visual ? "god-rays-visual" : "god-rays");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url), { build } = require("../packages/deep-engine/node_modules/esbuild");
const sourcePaths = ["packages/deep-engine/lab/iC18GodRaysProduction.ts", "packages/deep-engine/src/fog/volumetricGodRaysPass.ts",
  "packages/deep-engine/src/fog/volumetricGodRaysPassWgsl.ts", "packages/deep-engine/src/lighting/volumetricGodRaysWgsl.ts",
  "packages/deep-engine/src/webgpu/pbrGodRaysFrame.ts", "packages/deep-engine/src/webgpu/cascadedShadowResources.ts",
  "packages/deep-engine/src/webgpu/pbrPostProcessChain.ts", "packages/deep-engine/src/webgpu/pbrPostProcessOverrides.ts",
  "packages/deep-engine/src/fog/volumetricFogComposite.ts", "packages/deep-engine/src/webgpu/pbrFrameGraph.ts",
  "packages/deep-engine/src/webgpu/pbrFramePlanExecutor.ts", "packages/deep-engine/src/webgpu/pbrFramePlanResources.ts",
  "packages/deep-engine/src/webgpu/pbrRenderer.ts", "packages/deep-engine/src/webgpu/pbrOutputBindings.ts"];
sourcePaths.push("packages/deep-engine/src/webgpu/pbrPipelineSet.ts");
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
  [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
const sourcesBefore = await sourceHashes();
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/iC18GodRaysProduction.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") {
    response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs")));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}
body{margin:0;overflow:hidden;background:var(--bg-0)}canvas{display:block}</style></head><body></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
const runs = [], errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
    ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
  for (let round = 1; round <= 2; round++) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("saveGodRaysFrame", async name => {
      await page.screenshot({ path: path.join(out, `round-${round}-${name}.png`) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async exposure => (await import("/probe.mjs")).runIC18GodRaysProduction(
      name => globalThis.saveGodRaysFrame(name), exposure), visual ? .18 : 1);
    runs.push(result);
    console.log(JSON.stringify({ round, passed: result.passed, cpuError: result.cpuError, linearityError: result.linearityError,
      occludedSamples: result.occludedSamples, validationError: result.validationError, remainingResources: result.remainingResources }));
    await context.close();
    if (!result.passed) break;
  }
} catch (error) { errors.push(error.stack ?? String(error)); }
finally {
  const stable = runs.length === 2 && runs[0].shaderHash === runs[1].shaderHash
    && runs[0].occludedSamples === runs[1].occludedSamples && runs[0].cpuError === runs[1].cpuError;
  const sourcesAfter = await sourceHashes(), sourceFresh = JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter);
  const bundleSha256 = createHash("sha256").update(await readFile(path.join(out, "probe.mjs"))).digest("hex");
  const evidence = { passed: stable && sourceFresh && errors.length === 0 && runs.every(run => run.passed), stable, sourceFresh,
    sourceHashes: sourcesBefore, bundleSha256, freshRealms: runs.length, theme: "dark", width: 1920, height: 1080, runs, errors };
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output: out, passed: evidence.passed, stable, errors }));
  if (!evidence.passed) process.exitCode = 1;
  try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); }
}
