// One-off A01-X Babylon capture probe runner (headless). Not part of any gate; run manually:
//   node apps/web/scripts/probe-a01x-babylon-capture.mjs
// Bundles a full-surface vendor from the babylon-isolated workspace (via NODE_PATH so the
// probe entry stays out of babylon-isolated) and serves the probe page statically.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const { chromium } = playwright;

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const deepEngineRoot = resolve(repositoryRoot, "packages", "deep-engine");
const babylonIsolatedRoot = resolve(webRoot, "benchmarks/babylon-isolated");
const probeDir = resolve(repositoryRoot, "test-output/a01x-babylon-capture-probe");
const vendorOutDir = resolve(probeDir, "vendor");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
const esbuildBin = resolve(deepEngineRoot, "node_modules/esbuild/bin/esbuild");
if (!existsSync(esbuildBin)) throw new Error(`esbuild 不可用：${esbuildBin}`);
mkdirSync(probeDir, { recursive: true });
rmSync(vendorOutDir, { recursive: true, force: true });

// esbuild 的 CLI 不支持 NODE_PATH，包解析必须发生在 babylon-isolated 内：临时入口放进该目录，
// 打包完成后立即删除（babylon-isolated 的正式入口 benchVendorEntry.mjs 不受影响）。
const probeEntryInIsolated = resolve(babylonIsolatedRoot, "probeVendorEntry.tmp.mjs");
writeFileSync(probeEntryInIsolated, `export * from "@babylonjs/core/index.js";\n`, "utf8");

const vendorBuild = spawnSync(process.execPath, [esbuildBin,
  probeEntryInIsolated,
  "--bundle", "--format=esm", "--splitting", "--target=es2022", "--legal-comments=eof",
  `--outdir=${vendorOutDir}`, "--entry-names=probe-vendor", "--chunk-names=chunk-[hash]"],
  { cwd: babylonIsolatedRoot, encoding: "utf8" });
try { rmSync(probeEntryInIsolated, { force: true }); } catch { /* best effort */ }
if (vendorBuild.status !== 0) {
  throw new Error(`probe vendor 打包失败：\n${vendorBuild.stdout ?? ""}\n${vendorBuild.stderr ?? ""}`);
}
console.log(`[probe] vendor bundle ok -> ${vendorOutDir}`);

const server = createServer((request, response) => {
  const pathname = decodeURIComponent(request.url?.split("?")[0] ?? "/");
  let filePath;
  let contentType;
  if (pathname === "/") { filePath = resolve(probeDir, "probe.html"); contentType = "text/html; charset=utf-8"; }
  else if (pathname === "/probe.js") { filePath = resolve(probeDir, "probe.js"); contentType = "text/javascript; charset=utf-8"; }
  else if (pathname.startsWith("/vendor/")) {
    const name = pathname.slice("/vendor/".length);
    if (!/^[\w.-]+\.js$/.test(name)) { response.writeHead(403).end(); return; }
    filePath = resolve(vendorOutDir, name);
    contentType = "text/javascript; charset=utf-8";
  } else { response.writeHead(404).end(); return; }
  try {
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" })
      .end(readFileSync(filePath));
  } catch { response.writeHead(404).end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--js-flags=--expose-gc"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  await page.goto(origin, { waitUntil: "load", timeout: 60_000 });
  await page.waitForFunction(() => window.__probeDone === true, undefined, { timeout: 180_000 });
  const results = await page.evaluate(() => window.__probeResults);
  writeFileSync(resolve(probeDir, "probe-results.json"), `${JSON.stringify({ results, errors }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser.close().catch(() => {});
  await new Promise((closed) => server.close(() => closed()));
}
