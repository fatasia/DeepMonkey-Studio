import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/interrupted-0930/bloom-prefilter");
const baselineCommit = "cbce805a";
const tsPath = "packages/deep-engine/src/postprocess/bloomWgsl.ts";
const nativePath = "packages/deep-engine-native/assets/shaders/native_bloom_v1.wgsl";
const before = file => execFileSync("git", ["show", `${baselineCommit}:${file}`], { cwd: root, encoding: "utf8" });
const input = { baselineCommit, oldTs: before(tsPath), oldNative: before(nativePath),
  currentNative: await readFile(path.join(root, nativePath), "utf8"),
  canonical: await readFile(path.join(root, "packages/deep-engine/wgsl/bloomPrefilter.wgsl"), "utf8") };
await mkdir(out, { recursive: true });
await rm(path.join(out, "evidence.json"), { force: true });
const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j2BloomPrefilterGpuProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path.join(out, "probe.mjs"))); }
  else { response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head>
<body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h1>Bloom 软膝数学对拍</h1>
<p>TS / Native 原参数策略 · 生产公式提取前后 · 有限向量</p><div id="results"></div></body></html>`); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
    ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const runs = [];
  for (let round = 1; round <= 2; round++) {
    const result = await page.evaluate(async input =>
      (await import("/probe.mjs")).runJ2BloomPrefilterGpuProbe(input), input);
    runs.push(result);
    await page.evaluate(result => {
      const target = document.querySelector("#results"); target.replaceChildren();
      for (const row of result.results) { const line = document.createElement("p");
        line.textContent = `${row.profile} / ${row.id}: 前后误差 ${row.beforeAfterError} · ${row.passed ? "通过" : "失败"}`;
        target.append(line); }
    }, result);
    await page.screenshot({ path: path.join(out, `round-${round}.png`), fullPage: true });
  }
  const stable = JSON.stringify(runs[0]) === JSON.stringify(runs[1]);
  const evidence = { passed: stable && runs.every(run => run.passed), stable, runs };
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed: evidence.passed, stable, rowsPerRound: runs[0].results.length,
    maxBeforeAfterError: Math.max(...runs.flatMap(run => run.results.map(row => row.beforeAfterError))),
    maxCpuRelativeError: Math.max(...runs.flatMap(run => run.results.map(row => row.cpuRelativeError))),
    allExact: runs.every(run => run.results.every(row => row.exact)), errors: runs.map(run => run.errors) }, null, 2));
  if (!evidence.passed) process.exitCode = 1;
} finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
