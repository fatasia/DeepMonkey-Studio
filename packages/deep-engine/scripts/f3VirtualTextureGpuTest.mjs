// F3/T06 虚拟纹理真机证据 runner(骨架同 clothParallelGpuTest.mjs)。
// esbuild 打包 f3VirtualTextureGpuProbe.ts → 本地 http 服务 → playwright + headless
// Chrome(--enable-unsafe-webgpu)执行 → 证据落 test-output/f3-vt-evidence-20261002/<item>/。
// 用法:F3_VT_ITEM=a|b|c|d node f3VirtualTextureGpuTest.mjs
// 退出码:真机不可用(WebGPU 缺失)记 skip(退出 2);门限违约退出 1;通过退出 0。
// 纪律:帧时类测量本批禁测(并行负载);SSIM/正确性类允许。GPU 浏览器与另两路并行,
// 争用时重试一次并在证据 retryCount 注明。
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const item = (process.env.F3_VT_ITEM ?? "a").trim();
const outputDirectory = process.env.F3_VT_OUTPUT_DIR
  ? path.resolve(process.env.F3_VT_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "f3-vt-evidence-20261002", `item-${item}`);
const progressPath = path.join(path.dirname(outputDirectory), `progress-0${"abcd".indexOf(item) + 2}-${item}.json`);
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.F3_VT_TEST_ATTEMPTS ?? 2);
const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

const ITEM_TITLES = {
  a: "SSIM≥0.99 虚拟纹理 vs 全量纹理基线(1920×1080 冻结尺寸)",
  b: "相机 A→B→A 往返(终态页集/输出逐位一致)",
  c: "预算恢复(超预算→回收→解除→页集恢复服务)",
  d: "取消泄漏(中途取消上传/反馈→引擎+session 资源计数归零)",
};

async function writeProgress(patch) {
  const previous = await readFile(progressPath, "utf8").then(JSON.parse, () => ({}));
  await mkdir(path.dirname(progressPath), { recursive: true });
  await writeFile(progressPath, `${JSON.stringify({ item, title: ITEM_TITLES[item], ...previous, ...patch }, null, 2)}\n`);
}

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method !== "GET" || !["probe.html", "probe.bundle.mjs"].includes(name)) {
      response.writeHead(404).end(); return;
    }
    response.writeHead(200, { "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" })
      .end(await readFile(path.join(directory, name)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runInBrowser(item, origin) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const pageErrors = [];
    const unhandledRejections = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message)));
    await page.exposeFunction("__reportRejection", (message) => unhandledRejections.push(String(message)));
    await page.addInitScript(() => {
      window.addEventListener("unhandledrejection", (event) =>
        window.__reportRejection(String(event.reason?.message ?? event.reason)));
    });
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    await page.evaluate((value) => { window.__F3_ITEM = value; }, item);
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const result = await page.evaluate(async () => {
      const module = await import("./probe.bundle.mjs");
      try { return { ok: true, outcome: await module.runF3Item(window.__F3_ITEM) }; }
      catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error),
          stack: String(error instanceof Error ? error.stack ?? "" : "").slice(0, 2000) };
      }
    }, undefined, { timeout: 420000 });
    return { adapter, pageErrors, unhandledRejections, result };
  } finally { await browser.close(); }
}

async function main() {
  if (!"abcd".includes(item) || item.length !== 1) {
    console.error(`F3_VT_ITEM must be one of a|b|c|d, got: ${item}`);
    process.exitCode = 1; return;
  }
  const startedAt = new Date().toISOString();
  await writeProgress({ status: "running", startedAt, attempts: [] });
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "f3-vt-gpu-"));
  await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/f3VirtualTextureGpuProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"] });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>F3 virtual texture GPU probe</title></head><body></body></html>`);
  let probe = null;
  let attemptUsed = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptUsed = attempt;
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(item, origin);
      probe.attempt = attempt;
      // 结果可用(ok)即定案:门限失败是确定性证据,不重试、如实保留;
      // 仅传输/探针异常(ok=false/pageErrors)按并行争用重试一次并注明 retryCount。
      if (probe.result?.ok) break;
    } catch (error) {
      probe = { error: String(error instanceof Error ? error.message : error), attempt };
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  if (probe?.error || probe?.result?.error?.includes("WebGPU adapter unavailable")
    || probe?.result?.error?.includes("navigator.gpu unavailable")) {
    await writeProgress({ status: "skip-real-device-unavailable", finishedAt: new Date().toISOString(),
      error: probe?.error ?? probe?.result?.error });
    console.log(`F3 VT item ${item}: real device unavailable (${probe?.error ?? probe?.result?.error}). 真机留项如实记录。`);
    process.exitCode = 2; return;
  }
  const failed = !probe || probe.error || probe.pageErrors?.length || !probe.result?.ok;
  if (failed) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "probe-failure.json"), JSON.stringify(probe, null, 2));
    await writeProgress({ status: "probe-failure", finishedAt: new Date().toISOString(),
      error: probe?.error ?? probe?.result?.error ?? "unknown", pageErrors: probe?.pageErrors });
    console.log(`F3 VT item ${item} probe failed: ${JSON.stringify(probe)?.slice(0, 1200)}`);
    process.exitCode = 1; return;
  }
  const outcome = probe.result.outcome;
  const evidence = {
    schema: "f3-vt-real-device-evidence-v1",
    createdAt: new Date().toISOString(),
    lane: "f3-t06-virtual-texture-real-device",
    item, title: ITEM_TITLES[item],
    method: "esbuild→headless Chrome(--enable-unsafe-webgpu)→生产代码直调:DeviceSession.open 真机会话+VirtualTextureFrameBridge/AtlasResidency/TileLookup 全生产链;帧时类测量本批禁测(并行负载),仅正确性/一致性读回",
    retryCount: attemptUsed - 1,
    pageErrors: probe.pageErrors, unhandledRejections: probe.unhandledRejections,
    ...outcome,
  };
  await mkdir(outputDirectory, { recursive: true });
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await writeProgress({ status: outcome.pass ? "pass" : "gate-failed", finishedAt: new Date().toISOString(),
    attempts: attemptUsed, retryCount: attemptUsed - 1,
    evidence: evidencePath, evidenceSha256: sha256(await readFile(evidencePath)),
    pass: outcome.pass, summary: summarize(outcome) });
  console.log(`adapter: ${JSON.stringify(outcome.adapter)}`);
  console.log(`item ${item}: pass=${outcome.pass}`);
  console.log(`summary: ${summarize(outcome)}`);
  console.log(`evidence: ${evidencePath} (sha256=${sha256(await readFile(evidencePath))})`);
  if (!outcome.pass) process.exitCode = 1;
}

function summarize(outcome) {
  const result = outcome.result ?? {};
  if (item === "a") return `ssimMean=${result.ssim?.mean?.toFixed(6)} threshold=0.99 min=${result.ssim?.min?.toFixed(6)} `
    + `maxAbsDiff=${result.diff?.maxAbsDiff} magenta=${result.diff?.magentaCount}`;
  if (item === "b") return `residentSetIdentical=${result.residentSetIdentical} outputBitwiseEqual=${result.outputBitwiseEqual} `
    + `maxAbsDiff=${result.outputMaxAbsDiff} evictionsAfterB=${result.phaseB?.evictionsAtPhaseEnd - result.phaseA0?.evictionsAtPhaseEnd}`;
  if (item === "c") return `recoveredSetIdentical=${result.recoveredSetIdentical} samplingRestored=${result.samplingRestored} `
    + `squeezeEvictions=${result.stage2Squeeze?.evictionsAfterSqueeze} budgetHeldEveryFrame=${result.budgetHeldEveryFrame}`;
  if (item === "d") return `path1LeakFree=${result.path1?.leakFree} path2AllZero=${result.path2?.allZero} `
    + `deviceErrors=${result.deviceErrors?.length ?? 0}`;
  return "n/a";
}

await main();
