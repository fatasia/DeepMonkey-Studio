// I-C21 HDR 生产显示桥 runner：默认 SDR fresh 与显式请求回退 fresh（两轮各两 fresh）。
// 读数合同（apps/web Studio 生产入口）：diagnostics 无 hdrDisplay 键（默认）；显式请求
// fallback + 显式 SDR 原因码 + failClosed + SDR preferred format + 帧循环产出。
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/i-series-0930/hdr-display-production");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const sourcePaths = ["apps/web/src/viewer/StudioDeepWebGpuBridge.ts", "packages/deep-engine/src/webgpu/hdrDisplayCanvas.ts",
  "packages/deep-engine/src/webgpu/deviceSession.ts", "packages/deep-engine/src/threeBridge/deepWebGpuOptions.ts",
  "packages/deep-engine/src/webgpu/pbrOutputBindings.ts", "packages/deep-engine/src/webgpu/pbrHdrDisplayPipeline.ts"];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
  [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
const sourcesBefore = await sourceHashes();

// 生产模块经 esbuild 从源直接打包（apps/web tsconfig 路径同构由相对导入满足）。
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = scenario => `<html data-theme="dark"><head><meta charset="utf-8"><style>${css}
body{margin:0;overflow:hidden;background:var(--bg-0);color:var(--text-strong)}
#stage{width:1280px;height:720px}</style></head>
<body><div id="stage"></div><div id="diag"></div><script>window.__HDR_REQUEST__=${JSON.stringify(scenario.request)};</script></body></html>`;
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/probe")) {
    response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path.join(out, "probe.mjs")));
    return;
  }
  const scenario = new URL(request.url, "http://x").searchParams.get("scenario") ?? "sdr-default";
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(html({ request: scenario === "explicit-fallback" ? { enabled: true } : undefined }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
const errors = [], rounds = [];
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
    ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
  for (let round = 1; round <= 2; round++) {
    for (const scenario of ["sdr-default", "explicit-fallback"]) {
      const realm = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      const page = await realm.newPage();
      page.on("pageerror", error => errors.push(`round${round}/${scenario}: ${error.message}`));
      await page.goto(`http://127.0.0.1:${server.address().port}/?scenario=${scenario}`);
      const result = await page.evaluate(async () => (await import("/probe.mjs")).runHdrDisplayProductionProbe());
      rounds.push({ round, scenario, ...result });
      console.log(JSON.stringify({ round, scenario, ...result }));
      await realm.close();
    }
  }
} catch (error) { errors.push(error.stack ?? String(error)); }
finally {
  await server.close(); await browser?.close().catch(() => {});
}

function verdict(rounds) {
  const pick = (scenario, round) => rounds.find(r => r.scenario === scenario && r.round === round);
  const checks = [];
  for (let round = 1; round <= 2; round++) {
    const sdr = pick("sdr-default", round), fb = pick("explicit-fallback", round);
    checks.push({
      round,
      adapterNonFallback: sdr?.adapterNonFallback === true && fb?.adapterNonFallback === true,
      sdrNoCapabilityProbe: sdr?.capabilityPresent === false && sdr?.hdrMode === "none" && sdr?.canvasProbePerformed === false,
      sdrPreferredFormat: sdr?.sdrFormatMatch === true,
      sdrFramesFlowing: (sdr?.framesRendered ?? 0) >= 12,
      fallbackProbed: fb?.capabilityPresent === true,
      fallbackSdrMode: fb?.hdrMode === "sdr",
      fallbackReasonExplicit: typeof fb?.policyReason === "string" && fb.policyReason.length > 0 && fb.policyReason !== "opt-out",
      fallbackFailClosed: fb?.failClosed === true,
      fallbackSdrFormat: fb?.sdrFormatMatch === true,
      fallbackFramesFlowing: (fb?.framesRendered ?? 0) >= 12,
      noDeviceErrors: [sdr, fb].every(r => (r?.deviceErrors?.length ?? 0) === 0),
    });
  }
  const stable = JSON.stringify(rounds.filter(r => r.round === 1).map(r => [r.hdrMode, r.policyReason, r.failClosed, r.sdrFormatMatch, r.capabilityPresent]))
    === JSON.stringify(rounds.filter(r => r.round === 2).map(r => [r.hdrMode, r.policyReason, r.failClosed, r.sdrFormatMatch, r.capabilityPresent]));
  return { checks, stable, passed: checks.every(c => Object.values(c).every(v => v !== false)) && stable };
}
const verdictOut = rounds.length === 4 ? verdict(rounds) : { passed: false, stable: false, checks: [] };
const sourcesAfter = await sourceHashes(), sourceFresh = JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter);
const evidence = {
  passed: verdictOut.passed && sourceFresh && errors.length === 0,
  stable: verdictOut.stable, sourceFresh, verdict: verdictOut, rounds, errors,
  sources: sourcesAfter,
  scope: "production Studio bridge; default SDR fresh and explicit-request fallback fresh, two rounds each",
  excluded: ["physical HDR panel (EDID SHP extension absent on this host)", "PQ/HLG offline encoding sinks", "other hosts"],
  qualityCertifiedNote: "this host has no HDR panel; explicit-request path certifies fail-closed fallback only",
};
await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 1));
console.log("PASSED:", evidence.passed, "stable:", verdictOut.stable, "sourceFresh:", sourceFresh, "errors:", errors.length);
if (!evidence.passed) process.exitCode = 1;
