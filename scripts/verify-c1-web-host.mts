// C1 验证宿主 Node 驱动：esbuild 打包验证页 → 本机 Chrome(真实 WebGPU) 渲染 fixture →
// 读回像素落盘并与 Native 基线做对照统计。只交付帧与统计，不做阈值判定（归 P0-08 像素矩阵切片）。
// 用法: node_modules/.bin/tsx scripts/verify-c1-web-host.mts
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "..");
const output = resolve(repo, "test-output/c1-web-host-20260918");
const fixturePath = resolve(repo, "packages/deep-engine/fixtures/dashboard-composition-v1.json");
const nativeBaseline = resolve(repo, "test-output/dashboard-pixel-matrix-20260917/native/producer-page-0.png");
const nativeDimensions = resolve(repo, "test-output/dashboard-pixel-matrix-20260917/native/dimensions.json");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const pageUrlPath = "/page.html";

function fail(message: string): never { console.error(`C1-WEB-HOST FAIL: ${message}`); process.exit(1); }
if (!existsSync(chromePath)) fail(`Chrome 不存在: ${chromePath}（可用 BIM_STUDIO_CHROME_PATH 覆盖）`);
if (!existsSync(fixturePath)) fail(`fixture 缺失: ${fixturePath}`);
if (!existsSync(nativeBaseline)) fail(`Native 基线缺失: ${nativeBaseline}`);

// 1. esbuild 打包验证页（conditions: development 让 @bim-studio/deep-engine 直接走 src 源码）。
const requireFrom = (segment: string) => createRequire(join(repo, segment, "package.json"));
const { build } = requireFrom("apps/api")("esbuild") as typeof import("esbuild");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
await build({ absWorkingDir: repo, entryPoints: ["scripts/verify-c1-web-host-page.ts"],
  outfile: join(output, "page.js"), bundle: true, platform: "browser", format: "esm",
  conditions: ["development"], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });

// 2. playwright-core 取 .pnpm 下固定安装（根依赖未声明，不硬编码版本号）。
const pnpmRoot = join(repo, "node_modules/.pnpm");
const pwDirName = readdirSync(pnpmRoot).find(name => name.startsWith("playwright-core@"));
if (!pwDirName) fail("node_modules/.pnpm 下未找到 playwright-core");
const { chromium } = await import(pathToFileURL(join(pnpmRoot, pwDirName, "node_modules/playwright-core/index.mjs")).href);

// 3. 静态服务：验证页 + fixture（页面内 fetch，与 Native 读同一 fixture 文件）。
const pageJs = readFileSync(join(output, "page.js"));
const fixtureBytes = readFileSync(fixturePath);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>C1 web host verify</title></head>
<body><script type="module" src="/page.js"></script></body></html>`;
writeFileSync(join(output, "page.html"), html + "\n");
const server = createServer((request, response) => {
  const path = request.url?.split("?")[0] ?? "/";
  const body = path === "/page.js" ? { type: "text/javascript; charset=utf-8", data: pageJs }
    : path === "/fixture.json" ? { type: "application/json; charset=utf-8", data: fixtureBytes }
    : path === pageUrlPath ? { type: "text/html; charset=utf-8", data: Buffer.from(html) } : null;
  if (!body) { response.writeHead(404).end("not found"); return; }
  response.setHeader("content-type", body.type);
  response.end(body.data);
});
await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// 4. 真实浏览器 WebGPU 渲染；WebGPU 不可用/适配器拒绝时页面回传精确错误，此处 exit 1，不降级。
const browser = await chromium.launch({ executablePath: chromePath, headless: true,
  args: ["--enable-unsafe-webgpu"] });
let result: any;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", error => console.error("pageerror:", String(error).slice(0, 400)));
  await page.goto(baseUrl + pageUrlPath, { waitUntil: "load", timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__C1_RESULT !== undefined, null, { timeout: 90_000 });
  result = await page.evaluate(() => (window as any).__C1_RESULT);
} finally {
  await browser.close();
  server.close();
}
if (!result?.ok) fail(`Web 宿主在阶段「${result?.stage ?? "?"}」失败: ${result?.message ?? "no result"}`);
const pngBase64 = typeof result.pngDataUrl === "string" && result.pngDataUrl.startsWith("data:image/png;base64,")
  ? result.pngDataUrl.slice("data:image/png;base64,".length) : null;
if (!pngBase64) fail("页面回传缺少有效的 PNG data URL。");

// 5. 落盘：与 Native 证据同规格的 PNG + dimensions.json。
const webPngPath = join(output, "web-page-0.png");
writeFileSync(webPngPath, Buffer.from(pngBase64, "base64"));
const dimensions = { width: result.width, height: result.height, bytesPerRow: result.width * 4,
  format: "rgba8unorm-srgb", origin: "top-left",
  canvasFormat: result.canvasFormat, renderTargetFormat: result.renderTargetFormat,
  note: "WebGPU canvas 经 2d readback 得到 sRGB 编码 RGBA；canvasFormat 为浏览器呈现格式" };
writeFileSync(join(output, "dimensions.json"), JSON.stringify(dimensions, null, 2) + "\n");

// 6. 对照统计（不做阈值判定）：尺寸、彩色像素（r|g|b 非零，与 Native 测试同口径）、compareImageFiles 指标。
const sharp = requireFrom("apps/web")("sharp") as typeof import("sharp");
const { compareImageFiles } = await import(pathToFileURL(resolve(repo, "apps/web/scripts/renderImageSimilarity.mjs")).href);
async function coloredPixels(path: string): Promise<number> {
  const { data } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let offset = 0; offset < data.length; offset += 3) {
    if (data[offset] || data[offset + 1] || data[offset + 2]) count += 1;
  }
  return count;
}
const nativeColored = await coloredPixels(nativeBaseline);
const webColored = await coloredPixels(webPngPath);
let comparison: unknown;
try {
  comparison = await compareImageFiles(nativeBaseline, webPngPath, "native-producer-page-0", "web-page-0",
    { differencePath: join(output, "native-vs-web-diff.png") });
} catch (error) {
  comparison = { error: `compareImageFiles 不可用: ${error instanceof Error ? error.message : String(error)}` };
}
const summary = {
  fixture: "packages/deep-engine/fixtures/dashboard-composition-v1.json",
  fixtureAdaptation: { bypassedChartFrames: result.bypassedChartFrames, skippedChartSeries: result.skippedChartSeries,
    note: "无适配（均为空记录）：fixture 原样进 controller。2026-09-18 C1 缺口②起产品静态 chartFrame 已按 Native InteractionState::from_ir 同语义应用初始 dataZoom/actions（轴域窗口进几何；highlight/select 属运行期轮廓，两侧静态帧同样不产出像素，deferred 登记）。初始态拒绝若复现按缺陷上抛，禁止恢复剥离" },
  adapter: result.adapter, canvasFormat: result.canvasFormat, renderTargetFormat: result.renderTargetFormat,
  candidateIdentity: result.identity, releaseFailures: result.releaseFailures,
  web: { png: "web-page-0.png", ...dimensions, coloredPixels: webColored, pageReadbackColoredPixels: result.pageColoredPixels },
  native: { png: "../dashboard-pixel-matrix-20260917/native/producer-page-0.png",
    dimensions: JSON.parse(readFileSync(nativeDimensions, "utf8")), coloredPixels: nativeColored },
  comparison,
};
writeFileSync(join(output, "compare.json"), JSON.stringify(summary, null, 2) + "\n");
writeFileSync(join(output, "result.json"), JSON.stringify({ baseUrl, ok: true, web: summary.web, native: summary.native }, null, 2) + "\n");

console.log(`C1 web host: committed, adapter=${result.adapter ? `${result.adapter.vendor}/${result.adapter.device || result.adapter.description || "?"} fallback=${result.adapter.isFallbackAdapter}` : "info-unavailable"}`);
console.log(`canvas=${result.canvasFormat} target=${result.renderTargetFormat} frame=${result.width}x${result.height}`);
console.log(`colored pixels: web=${webColored} native=${nativeColored} (fixture page-0)`);
console.log(`comparison: ${JSON.stringify(comparison)}`);
console.log(`output: ${output}`);
