import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/i-series-0930/pipeline-compile");
await mkdir(out, { recursive: true });
await rm(path.join(out, "evidence.json"), { force: true });
const require = createRequire(import.meta.url), { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/iC26PipelineCompileProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path.join(out, "probe.mjs"))); }
  else { response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head>
<body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h1>PBR 编译诊断</h1>
<p>实际首帧关键等待 / 背景完成 / 同设备同布局复用 · 编译观察值</p><div id="results"></div></body></html>`); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
    ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const runs = [];
  for (let round = 1; round <= 2; round++) {
    const result = await page.evaluate(async () => (await import("/probe.mjs")).runIC26PipelineCompileProbe());
    runs.push(result);
    await page.evaluate(result => {
      const target = document.querySelector("#results"); target.replaceChildren();
      for (const text of [
        `公共快照：${result.publicSnapshot.records.length}条 · 冻结 ${result.publicSnapshot.snapshotFrozen} · 首帧 ${result.publicSnapshot.firstFrame.frame}`,
        `冷建：关键 ${result.cold.criticalWaitMs.toFixed(3)}ms · 全部 ${result.cold.allWaitMs.toFixed(3)}ms · ${result.cold.allRecords}条`,
        `同设备复用：关键 ${result.warm.criticalWaitMs.toFixed(3)}ms · 全部 ${result.warm.allWaitMs.toFixed(3)}ms · 新编译 ${result.warm.allRecords}条`,
        `资源残留 ${result.resourcesAfterDispose} · 实际shader ${result.shaderHash}`,
      ]) { const line = document.createElement("p"); line.textContent = text; target.append(line); }
    }, result);
    await page.screenshot({ path: path.join(out, `round-${round}.png`) });
  }
  const structuralStable = runs[0].shaderHash === runs[1].shaderHash &&
    runs[0].cold.allRecords === runs[1].cold.allRecords && runs[0].warm.allRecords === runs[1].warm.allRecords;
  const evidence = { passed: structuralStable && runs.every(run => run.passed), structuralStable, runs,
    timingStability: "Wall-clock observations are not expected to be byte-identical; no performance threshold changed." };
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: evidence.passed, structuralStable,
    runs: runs.map(run => ({ cold: { criticalMs: run.cold.criticalWaitMs, allMs: run.cold.allWaitMs,
      records: run.cold.allRecords, background: run.cold.backgroundRecords },
      warm: { criticalMs: run.warm.criticalWaitMs, allMs: run.warm.allWaitMs, records: run.warm.allRecords,
        samePipelineSet: run.warm.samePipelineSet }, publicRecords: run.publicSnapshot.records.length,
      firstFrame: run.publicSnapshot.firstFrame, residual: run.resourcesAfterDispose })) }, null, 2));
  if (!evidence.passed) process.exitCode = 1;
} finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
