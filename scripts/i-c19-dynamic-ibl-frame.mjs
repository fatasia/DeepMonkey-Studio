// I-C19 动态 IBL GPU 生产 runner：CPU 参考 vs GPU prefilter 场景对拍 + 热替换 A→B→A
// + 降级钳制 + validation 空 + 资源账目，两 fresh 轮。
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/i-series-1001/dynamic-ibl");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const sourcePaths = ["packages/deep-engine/lab/iC19DynamicIblProduction.ts", "packages/deep-engine/lab/iblPrefilterReference.ts",
  "packages/deep-engine/lab/iblReferenceEncode.ts", "packages/deep-engine/src/webgpu/dynamicIblResidency.ts",
  "packages/deep-engine/src/webgpu/pbrRenderer.ts", "packages/deep-engine/src/webgpu/hdrEnvironment.ts",
  "packages/deep-engine/src/webgpu/prefilteredEnvironment.ts", "packages/deep-engine/lab/iC19KeptMipsProduction.ts",
  "packages/deep-engine/src/webgpu/environmentMipSelection.ts", "packages/deep-engine/src/webgpu/studioEnvironment.ts",
  "packages/deep-engine/src/webgpu/pbrEnvironmentSource.ts", "packages/deep-engine/src/webgpu/pbrMainBindings.ts",
  "packages/deep-engine/src/webgpu/pbrReflectionProbes.ts", "packages/deep-engine/src/webgpu/pbrReflectionProbeWgsl.ts"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
  [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
const sourcesBefore = await sourceHashes();
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/iC19DynamicIblProduction.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser", conditions: ["development"] });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") {
    response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs")));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}
body{margin:0;overflow:hidden;background:var(--bg-0);color:var(--text-strong)}
h2{margin:8px 16px}#stage{width:640px;height:360px}</style></head>
<body><h2>动态 IBL · CPU 参考 vs GPU prefilter · 热替换 A→B→A · 降级钳制</h2><div id="stage"></div></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
const rounds = [], errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
    ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
  for (let round = 1; round <= 2; round++) {
    const realm = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await realm.newPage();
    page.on("pageerror", error => errors.push(`round${round}: ${error.message}`));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => (await import("/probe.mjs")).runDynamicIblProductionProbe());
    rounds.push({ round, ...result });
    console.log(JSON.stringify({ round, ...result }));
    if (round === 1) await page.screenshot({ path: path.join(out, "round-1.png") });
    await realm.close();
  }
} catch (error) { errors.push(error.stack ?? String(error)); }
finally { await server.close(); await browser?.close().catch(() => {}); }

const stable = rounds.length === 2 && JSON.stringify([rounds[0].referenceParity, rounds[0].hotSwap, rounds[0].degradedClamp, rounds[0].outstandingLeases])
  === JSON.stringify([rounds[1].referenceParity, rounds[1].hotSwap, rounds[1].degradedClamp, rounds[1].outstandingLeases]);
const gates = rounds.every(r => r.adapterNonFallback === true && r.referenceParity.pass === true
  && r.hotSwap.generationReturn === true && r.hotSwap.repeatStableMaxError <= 0.002
  && r.degradedClamp.finite === true && r.degradedClamp.sharpClampError <= .002
  && r.degradedClamp.roughPreservationError <= .002 && r.degradedClamp.hdrTailError <= .002
  && r.degradedClamp.sharpSignal > .01 && r.degradedClamp.expectedSavedBytes > 0
  && r.degradedClamp.actualSavedBytes === r.degradedClamp.expectedSavedBytes
  && r.outstandingLeases === 0 && r.deviceErrors.length === 0);
const sourcesAfter = await sourceHashes(), sourceFresh = JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter);
const evidence = {
  passed: rounds.length === 2 && stable && gates && sourceFresh && errors.length === 0,
  stable, gates, sourceFresh, rounds, errors, sources: sourcesAfter,
  scope: "dynamic IBL production: CPU-reference vs GPU-prefilter scene parity, hot swap A->B->A, degraded clamp; two fresh rounds",
  excluded: ["mip-level readback (per-mip scene fingerprints instead)", "author panel screenshots (separate visual acceptance)", "automatic global budget/LUT sharing", "other hosts"],
};
await rm(path.join(out, "evidence.json"), { force: true });
await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 1));
console.log("PASSED:", evidence.passed, "stable:", stable, "gates:", gates, "sourceFresh:", sourceFresh, "errors:", errors.length);
if (!evidence.passed) process.exitCode = 1;
