import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runFreshProbeGiNative, validateProbeGiNativeEvidence } from "./lib/j2ProbeGiNativeRun.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/interrupted-0930/probe-gi-parity");
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--chrome-only", "--compare", "--offline"].includes(flag)) throw Error(`Unknown option ${flag}`);
if (flags.size > 1) throw Error("Choose one of --chrome-only, --compare, --offline");
const chromeOnly = flags.has("--chrome-only"), historical = flags.has("--compare") || flags.has("--offline");
await mkdir(out, { recursive: true });
const fixtureRaw = await readFile(path.join(root, "packages/deep-engine/fixtures/j2-probe-gi-v1.json"), "utf8");
const fixture = JSON.parse(fixtureRaw);
let native;
if (!chromeOnly && !historical) native = await runFreshProbeGiNative({ root, out, fixture });
else {
  if (historical) native = validateProbeGiNativeEvidence(JSON.parse(await readFile(path.join(out, "native.json"), "utf8")), fixture);
  await rm(path.join(out, "evidence.json"), { force: true });
}
const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j2ProbeGiGpuProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const nativeSource = await readFile(path.join(root, "packages/deep-engine-native/assets/shaders/native_mesh_v1.wgsl"), "utf8");
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs"))); }
  else { response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h1>探针 GI 生产采样</h1><p>共享 storage 核 / Native 生产函数 · 相同输入</p><div id="results"></div></body></html>`); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 980, height: 1100 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const runs = [];
  for (let round = 1; round <= 2; round++) {
    const result = await page.evaluate(async ({ fixture, nativeSource, fixtureRaw }) =>
      (await import("/probe.mjs")).runJ2ProbeGiGpuProbe(fixture, nativeSource, fixtureRaw), { fixture, nativeSource, fixtureRaw });
    runs.push(result);
    await page.evaluate(result => {
      const root = document.querySelector("#results"); root.replaceChildren();
      for (const row of result.results) { const line = document.createElement("p");
        line.textContent = `${row.leg} / ${row.id}: ${row.value.map(v => v.toFixed(6)).join(" · ")} / ${row.passed ? "通过" : "失败"}`;
        root.append(line); }
    }, result);
    await page.screenshot({ path: path.join(out, `round-${round}.png`), fullPage: true });
  }
  const stable = JSON.stringify(runs[0]) === JSON.stringify(runs[1]);
  const comparisons = native ? runs[0].results.filter(row => row.leg === "native-production-storage").map(row => {
    const match = native.results.find(result => result.id === row.id);
    if (!match) throw Error(`Native evidence missing case ${row.id}`);
    const error = Math.max(...row.value.map((value, index) => Math.abs(value - match.value[index])));
    return { id: row.id, maxError: error, passed: Number.isFinite(error) && error <= fixture.tolerance };
  }) : [];
  const identityMatched = native ? native.fixtureHash === runs[0].fixtureHash
    && native.sourceHash === runs[0].results.find(row => row.leg === "native-production-storage").sourceHash : null;
  const passed = stable && runs.every(run => run.passed)
    && (!native || identityMatched && native.passed && comparisons.every(row => row.passed));
  const scope = chromeOnly ? "Chrome only; Native host not measured" : historical
    ? "Fresh Chrome + historical Native file comparison; Native host not executed this run"
    : "Current Chrome + current Native wgpu finite storage-vector parity";
  const evidence = { passed, stable, scope, nativeRunFresh: !chromeOnly && !historical,
    identityMatched, comparisons, runs, native: native ?? null };
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ passed, stable, scope: evidence.scope, identityMatched,
    rows: runs[0].results.length, comparisons }, null, 2));
  if (!passed) process.exitCode = 1;
} finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
