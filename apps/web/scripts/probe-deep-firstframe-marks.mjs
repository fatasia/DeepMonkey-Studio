// 首帧相位归因探针:deep-webgpu 基准页(1000 物 static)跑 N 次,采集
// window 快照(firstFrameMs)与 deep-webgpu:* performance marks(相位墙钟分解)。
// 冷 = 每次全新浏览器进程(headless Dawn shader 磁盘缓存禁用,即基线口径);
// 热 = 同一持久 profile 有头进程内连续加载(Dawn 磁盘缓存命中)。
//
// 用法:
//   node scripts/probe-deep-firstframe-marks.mjs                 # 冷 3 次
//   HEADLESS=0 PROFILE=<dir> node scripts/probe-deep-firstframe-marks.mjs   # 热(持久 profile)
// 输出:test-output/deep-firstframe-marks/<tag>.json
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const execFileAsync = promisify(execFile);
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const distRoot = resolve(repositoryRoot, "test-output/render-engine-comparison/dist");
const outputRoot = resolve(repositoryRoot, "test-output/deep-firstframe-marks");
const runs = Number(process.env.RUNS ?? 3);
const objectCount = Number(process.env.COUNT ?? 1000);
const hotMode = process.env.HEADLESS === "0" && Boolean(process.env.PROFILE);
const tag = process.env.TAG ?? (hotMode ? "hot" : "cold");

const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const file = resolve(distRoot, url.pathname === "/" ? "index.html" : url.pathname.slice(1));
    const body = await readFile(file);
    const ext = `.${resolve(file).split(".").pop().toLowerCase()}`;
    res.writeHead(200, { "content-type": mime[ext] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;
await mkdir(outputRoot, { recursive: true });

const launchOptions = {
  executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: !hotMode,
  args: ["--enable-unsafe-webgpu", "--js-flags=--expose-gc"],
};

const report = { schema: "deep-monkey.deep-firstframe-marks.v1", createdAt: new Date().toISOString(),
  mode: hotMode ? "hot-persistent-profile" : "cold-fresh-process", objectCount, runs: [] };

for (let run = 1; run <= runs; run += 1) {
  const browser = hotMode && run > 1
    ? null // 热模式复用首个进程
    : await playwright.chromium.launch(hotMode
      ? { ...launchOptions } // 热模式 run1 也走持久 profile(建目录)
      : launchOptions);
  const context = hotMode
    ? await (browser ?? globalThis.__hotBrowser).newContext({ viewport: { width: 1440, height: 900 } })
    : null;
  if (hotMode && run === 1) globalThis.__hotBrowser = browser;
  const page = hotMode ? await context.newPage() : await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error).slice(0, 300)));
  const url = `${origin}/?engine=deep-webgpu&workload=static&count=${objectCount}`;
  const gotoAt = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(() => window.__renderEngineBenchmark?.ready || window.__renderEngineBenchmark?.error, undefined, { timeout: 120_000 });
  const state = await page.evaluate(() => ({
    snapshot: window.__renderEngineBenchmark?.snapshot,
    error: window.__renderEngineBenchmark?.error,
    marks: performance.getEntriesByType("mark").filter((entry) => entry.name.startsWith("deep-webgpu:"))
      .map((entry) => ({ name: entry.name.replace("deep-webgpu:", ""), at: entry.startTime })),
    measures: performance.getEntriesByType("measure").length,
  }));
  if (state.error) errors.push(state.error);
  const marks = state.marks;
  const phases = [];
  let prev = null;
  for (const mark of marks) {
    phases.push({ name: mark.name, at: Number(mark.at.toFixed(1)),
      ...(prev ? { deltaMs: Number((mark.at - prev.at).toFixed(1)) } : {}) });
    prev = mark;
  }
  report.runs.push({
    run, gotoToReadyMs: Number((Date.now() - gotoAt).toFixed(1)),
    firstFrameMs: state.snapshot ? Number(state.snapshot.firstFrameMs.toFixed(1)) : null,
    initializedMs: state.snapshot ? Number(state.snapshot.initializedMs.toFixed(1)) : null,
    phases, errors,
  });
  console.log(`[marks] ${tag} run${run}: firstFrame=${report.runs.at(-1).firstFrameMs}ms goto→ready=${report.runs.at(-1).gotoToReadyMs}ms`);
  if (!hotMode) await browser.close();
  else { await page.close(); await context.close(); }
}
if (hotMode) await globalThis.__hotBrowser.close();
server.close();
const out = resolve(outputRoot, `${tag}.json`);
await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`[marks] 已写入 ${out}`);
