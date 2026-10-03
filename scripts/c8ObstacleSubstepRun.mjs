// C8 障碍接触场景逐子步对拍 runner(驱动 packages/deep-engine/scripts/c8ObstacleSubstepProbe.ts)。
// 骨架同 clothParallelGpuTest.mjs:esbuild 打包 → 本地 http → playwright headless Chrome(--enable-unsafe-webgpu)。
// 证据落 test-output/c8-obstacle-substep-20261002/(C8_OBSTACLE_OUTPUT_DIR 可覆盖)。本 runner 不设门,只落证据。
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// esbuild 从 deep-engine 包解析(包内直接依赖)。
const packageRequire = createRequire("D:/Documents/bim/bim-studio/packages/deep-engine/package.json");
const { build } = packageRequire("esbuild");

const packageRoot = fileURLToPath(new URL("../packages/deep-engine/", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.C8_OBSTACLE_OUTPUT_DIR
  ? path.resolve(process.env.C8_OBSTACLE_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "c8-obstacle-substep-20261002");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

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

async function runInBrowser(origin) {
  // pnpm store 直连(仓库根 node_modules 无顶层链接,cloud-render-worker 本地链接已剪枝);CJS require 取 chromium。
  const storeRequire = createRequire("file:///D:/Documents/bim/bim-studio/node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js");
  const playwright = storeRequire("playwright-core");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
    const pageErrors = [];
    const consoleErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error.message)));
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const result = await page.evaluate(async () => {
      const module = await import("./probe.bundle.mjs");
      try { return { ok: true, result: await module.runC8ObstacleSubstepProbe() }; }
      catch (error) {
        return { ok: false, error: String(error instanceof Error ? error.message : error),
          stack: String(error instanceof Error ? error.stack ?? "" : "").slice(0, 2000) };
      }
    }, undefined, { timeout: 600000 });
    return { adapter, pageErrors, consoleErrors, payload: result };
  } finally { await browser.close(); }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "c8-obstacle-substep-"));
  await build({ absWorkingDir: packageRoot, entryPoints: ["scripts/c8ObstacleSubstepProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: path.join(bundleDirectory, "probe.bundle.mjs"),
    logLevel: "silent", conditions: ["development"] });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>C8 obstacle substep probe</title></head><body></body></html>`);
  let probe = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try { probe = await runInBrowser(origin); if (!probe.pageErrors?.length && probe.payload?.ok) break; }
    catch (error) { probe = { error: String(error instanceof Error ? error.message : error) }; }
    finally { server.close(); }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => {});
  await mkdir(outputDirectory, { recursive: true });
  if (!probe || probe.error || !probe.payload?.ok) {
    const failure = { schema: "c8-obstacle-substep-failure-v1", probe };
    await writeFile(path.join(outputDirectory, "probe-failure.json"), JSON.stringify(failure, null, 1));
    console.log(`c8 obstacle substep probe failed: ${JSON.stringify(probe)?.slice(0, 1200)}`);
    process.exitCode = 1; return;
  }
  const result = probe.payload.result;
  const evidence = {
    schema: "c8-obstacle-substep-probe-evidence-v1",
    createdAt: new Date().toISOString(),
    lane: "c8-obstacle-substep-gpu-real-device",
    method: "逐子步分解(substeps=1+dt/8)+ bulk 整 tick 保真对拍 + 四方误差表(GPU/镜像/黄金构建序/黄金色序)+ 1-ULP 混沌判据",
    adapter: probe.adapter,
    pageErrors: probe.pageErrors,
    consoleErrors: probe.consoleErrors,
    result,
  };
  const evidencePath = path.join(outputDirectory, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 1)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  console.log(`decomposition: finalBitwiseEqual=${result.decomposition.finalBitwiseEqual} bulkDoubleRunBitwise=${result.decomposition.bulkDoubleRunBitwise}`);
  console.log(`bulkGoldenErrByTick: ${JSON.stringify(result.anchors.bulkGoldenErrByTick)}`);
  console.log(`contactOnset: ${JSON.stringify(result.milestones.contactOnset)}`);
  console.log(`milestones: ${JSON.stringify(result.milestones, null, 1)}`);
  console.log(`checkpoints: ${JSON.stringify(result.checkpoints, null, 1)}`);
  console.log(`final: ${JSON.stringify(result.final, null, 1)}`);
  console.log(`evidence: ${evidencePath} (sha256=${sha256(await readFile(evidencePath))})`);
}

await main();
