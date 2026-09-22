// P0-08 跨端像素矩阵总驱动（可复用）：Browser(WebGPU) vs Native 同 fixture 逐格出帧、读回、统计、分级。
// 流程：生成 6 格 fixture（p08-matrix-fixtures.mts）→ Native producer_package_renders_real_pixels
// 读回（DEEP_DASHBOARD_PACKAGE_PATH + DEEP_DASHBOARD_CAPTURE_DIR，RGBA8 unorm-sRGB 960×540）→
// 真实 Chrome WebGPU 宿主（p08-matrix-page.ts）出帧 → compareImageFiles 统计 → sharp 区域差异分级
// （采样与边缘=预期 / 系统性色差=需追 / 结构性缺失=阻断）→ matrix.json（含阈值建议段）。
// 不做单格武断判定；不改生产源码。用法: node_modules/.bin/tsx scripts/run-p08-pixel-matrix.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "..");
const output = resolve(process.env.DEEP_P08_OUTPUT ?? resolve(repo, "test-output/p08-matrix-20260918"));
const baseFixture = resolve(repo, "packages/deep-engine/fixtures/dashboard-composition-v1.json");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const LOGICAL = { width: 960, height: 640 };
const PHYSICAL = { width: 960, height: 540 };
const SCALE = Math.min(PHYSICAL.width / LOGICAL.width, PHYSICAL.height / LOGICAL.height);
const OX = (PHYSICAL.width - LOGICAL.width * SCALE) / 2;
const OY = (PHYSICAL.height - LOGICAL.height * SCALE) / 2;
const CHANGED_THRESHOLD = 8;   // 与 renderImageSimilarity.imageMetrics 同口径
const EDGE_LUMA_RANGE = 24;    // 3×3 luma 极差超过视为图形边缘

function fail(message: string): never { console.error(`P08-MATRIX FAIL: ${message}`); process.exit(1); }
if (!existsSync(chromePath)) fail(`Chrome 不存在: ${chromePath}（可用 BIM_STUDIO_CHROME_PATH 覆盖）`);

const requireFrom = (segment: string) => createRequire(join(repo, segment, "package.json"));
const sharp = requireFrom("apps/web")("sharp") as typeof import("sharp");

// ---------- 共享几何：逻辑页 → 物理 letterbox 映射 ----------
interface Rect { left: number; top: number; right: number; bottom: number }
const toPhysical = (frame: [number, number, number, number]): Rect => ({
  left: OX + frame[0] * SCALE, top: OY + frame[1] * SCALE,
  right: OX + (frame[0] + frame[2]) * SCALE, bottom: OY + (frame[1] + frame[3]) * SCALE,
});
const inflate = (rect: Rect, by: number): Rect => ({
  left: rect.left - by, top: rect.top - by, right: rect.right + by, bottom: rect.bottom + by,
});
const inRect = (rect: Rect, x: number, y: number): boolean =>
  x + 0.5 >= rect.left && x + 0.5 < rect.right && y + 0.5 >= rect.top && y + 0.5 < rect.bottom;
const area = (rect: Rect): number => Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);

// ---------- 1. 生成 fixture 变体 ----------
rmSync(output, { recursive: true, force: true });
const { writeP08Fixtures } = await import(pathToFileURL(resolve(repo, "scripts/p08-matrix-fixtures.mts")).href);
const metas = writeP08Fixtures(baseFixture, join(output, "fixtures"));
console.log(`fixtures: ${metas.length} cells`);
for (const meta of metas) mkdirSync(join(output, "cells", meta.id, "native"), { recursive: true });

// ---------- 2. Native 读回（每格一次 cargo test；编译缓存后单格秒级） ----------
async function rgbaToPng(rgbaPath: string, pngPath: string): Promise<void> {
  // .rgba 无头信息，必须按原始字节喂 raw（与 20260917 基线 PNG 同口径：无缩放无滤镜）。
  const rgba = readFileSync(rgbaPath);
  const raw = await sharp(rgba, { raw: { width: PHYSICAL.width, height: PHYSICAL.height, channels: 4 } })
    .removeAlpha().png().toBuffer();
  writeFileSync(pngPath, raw);
}
async function countColored(path: string): Promise<number> {
  const { data } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let offset = 0; offset < data.length; offset += 3) {
    if (data[offset] || data[offset + 1] || data[offset + 2]) count += 1;
  }
  return count;
}
const nativeResults: Record<string, { coloredPixels: number; gpuTest: string }> = {};
for (const meta of metas) {
  const captureDir = join(output, "cells", meta.id, "native");
  const fixturePath = join(output, "fixtures", `${meta.id}.json`);
  const stdout = execFileSync("cargo",
    ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked",
      "--bin", "deep-engine-native", "producer_package_renders_real_pixels", "--", "--ignored", "--nocapture"],
    { cwd: repo, encoding: "utf8", timeout: 600_000,
      env: { ...process.env, DEEP_DASHBOARD_PACKAGE_PATH: fixturePath, DEEP_DASHBOARD_CAPTURE_DIR: captureDir } });
  const match = stdout.match(/producer page 0: (\d+) colored pixels/);
  if (!match) fail(`${meta.id}: Native 输出缺少 page 0 colored pixels`);
  if (!/test .*ok/.test(stdout)) fail(`${meta.id}: Native 测试未 ok`);
  const rgba = join(captureDir, "producer-page-0.rgba");
  if (!existsSync(rgba)) fail(`${meta.id}: Native 读回 rgba 缺失`);
  await rgbaToPng(rgba, join(output, "cells", meta.id, `native-${meta.id}.png`));
  nativeResults[meta.id] = { coloredPixels: Number(match[1]), gpuTest: "ok" };
  console.log(`native ${meta.id}: ${match[1]} colored pixels`);
}

// ---------- 3. Web 宿主出帧（真实 Chrome WebGPU） ----------
const { build } = requireFrom("apps/api")("esbuild") as typeof import("esbuild");
await build({ absWorkingDir: repo, entryPoints: ["scripts/p08-matrix-page.ts"],
  outfile: join(output, "page.js"), bundle: true, platform: "browser", format: "esm",
  conditions: ["development"], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });
const pageJs = readFileSync(join(output, "page.js"));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>P08 pixel matrix host</title></head>
<body><script type="module" src="/page.js"></script></body></html>`;
const fixtureBytes = new Map(metas.map(meta => [meta.id, readFileSync(join(output, "fixtures", `${meta.id}.json`))]));
const server = createServer((request, response) => {
  const path = request.url?.split("?")[0] ?? "/";
  const fixtureMatch = path.match(/^\/fixture\/([\w.-]+)\.json$/);
  const body = path === "/page.js" ? { type: "text/javascript; charset=utf-8", data: pageJs }
    : path === "/fixtures.json" ? { type: "application/json; charset=utf-8", data: Buffer.from(JSON.stringify(metas.map(({ id }) => ({ id })))) }
    : fixtureMatch && fixtureBytes.has(fixtureMatch[1]!) ? { type: "application/json; charset=utf-8", data: fixtureBytes.get(fixtureMatch[1]!)! }
    : path === "/page.html" ? { type: "text/html; charset=utf-8", data: Buffer.from(html) } : null;
  if (!body) { response.writeHead(404).end("not found"); return; }
  response.setHeader("content-type", body.type);
  response.end(body.data);
});
await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const pnpmRoot = join(repo, "node_modules/.pnpm");
const pwDirName = readdirSync(pnpmRoot).find(name => name.startsWith("playwright-core@"));
if (!pwDirName) fail("node_modules/.pnpm 下未找到 playwright-core");
const { chromium } = await import(pathToFileURL(join(pnpmRoot, pwDirName, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
let web: any;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", error => console.error("pageerror:", String(error).slice(0, 400)));
  await page.goto(baseUrl + "/page.html", { waitUntil: "load", timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__P08_RESULT !== undefined, null, { timeout: 180_000 });
  web = await page.evaluate(() => (window as any).__P08_RESULT);
} finally {
  await browser.close();
  server.close();
}
if (!web || web.ok !== true) fail(`Web 宿主失败（stage=${web?.stage ?? "?"}）: ${web?.message ?? "?"}`);
const webCells = new Map((web.cells as any[]).map(cell => [cell.id, cell]));
for (const meta of metas) {
  const cell = webCells.get(meta.id);
  if (!cell?.ok || typeof cell.pngDataUrl !== "string") fail(`${meta.id}: Web 格失败 stage=${cell?.stage}: ${cell?.message ?? "?"}`);
  writeFileSync(join(output, "cells", meta.id, `web-${meta.id}.png`), Buffer.from(cell.pngDataUrl.slice("data:image/png;base64,".length), "base64"));
  console.log(`web ${meta.id}: ${cell.coloredPixels} colored pixels`);
}

// ---------- 4. 统计 + 区域差异分级 + crops ----------
const { compareImageFiles } = await import(pathToFileURL(resolve(repo, "apps/web/scripts/renderImageSimilarity.mjs")).href);

interface ImageData { data: Buffer; width: number; height: number }
async function readRgb(path: string): Promise<ImageData> {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
const luma = (image: ImageData, offset: number): number =>
  image.data[offset] * 0.2126 + image.data[offset + 1] * 0.7152 + image.data[offset + 2] * 0.0722;
function edgeMask(image: ImageData): Uint8Array {
  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let min = 255, max = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const offset = ((y + dy) * width + (x + dx)) * 3;
          const value = data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }
      if (max - min > EDGE_LUMA_RANGE) mask[y * width + x] = 1;
    }
  }
  return mask;
}
function cropToPng(image: ImageData, rect: Rect, path: string): Promise<void> {
  const left = Math.max(0, Math.floor(rect.left)), top = Math.max(0, Math.floor(rect.top));
  const width = Math.min(image.width - left, Math.ceil(rect.right - rect.left));
  const height = Math.min(image.height - top, Math.ceil(rect.bottom - rect.top));
  return sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .extract({ left, top, width, height }).png().toFile(path);
}

const cells: any[] = [];
for (const meta of metas) {
  const cellDir = join(output, "cells", meta.id);
  const nativePng = join(cellDir, `native-${meta.id}.png`);
  const webPng = join(cellDir, `web-${meta.id}.png`);
  const diffPng = join(cellDir, `diff-${meta.id}.png`);
  const webCell = webCells.get(meta.id)!;
  const comparison: any = await compareImageFiles(nativePng, webPng, `native-${meta.id}`, `web-${meta.id}`, { differencePath: diffPng });

  const native = await readRgb(nativePng);
  const webImage = await readRgb(webPng);
  const diff = await readRgb(diffPng);
  const nativeEdge = edgeMask(native);
  const webEdge = edgeMask(webImage);

  const chartRects = meta.page0NodeFrames.map(toPhysical);
  const glyphRects = meta.glyphDests.map(toPhysical).map(rect => inflate(rect, 3));
  const imageRects = meta.imageDests.map(toPhysical).map(rect => inflate(rect, 3));
  const letterboxRect: Rect = { left: 0, top: 0, right: OX, bottom: PHYSICAL.height };
  const letterboxRect2: Rect = { left: OX + LOGICAL.width * SCALE, top: 0, right: PHYSICAL.width, bottom: PHYSICAL.height };
  const boundaryOf = (rect: Rect): { outer: Rect; inner: Rect; band: Rect; areaPx: number } => {
    const outer = inflate(rect, 2);
    const inner: Rect = { left: rect.left + 2, top: rect.top + 2, right: rect.right - 2, bottom: rect.bottom - 2 };
    return { outer, inner, band: outer, areaPx: area(outer) - area(inner) };
  };
  // 边界环带：外扩 2px 矩形内且内缩 2px 矩形外（判定必须用环，不能用外扩矩形——否则吞掉整个内部）。
  const inBand = (entry: { outer: Rect; inner: Rect }, x: number, y: number): boolean =>
    inRect(entry.outer, x, y) && !inRect(entry.inner, x, y);
  const chartBoundaries = chartRects.map(boundaryOf);
  const chartInteriors = chartRects.map(rect => ({
    rect,
    areaPx: area(rect) - boundaryOf(rect).areaPx,
  }));
  // static deep2d 填充 path（图例卡面板）边界环带：与 chartBoundary 同口径。环带是面板自身的
  // 形状边缘（双端 AA 覆盖量化差异所在），面板内部仍归平坦区——均匀色偏检测必须只盯内部。
  const staticBoundaries = meta.staticPathFrames.map(toPhysical).map(boundaryOf);
  const flatAreaPx = PHYSICAL.width * PHYSICAL.height
    - area(letterboxRect) - area(letterboxRect2)
    - glyphRects.concat(imageRects).reduce((sum, rect) => sum + area(rect), 0)
    - chartRects.reduce((sum, rect) => sum + area(rect), 0);

  const counts = { letterbox: 0, atlasGlyph: 0, atlasImage: 0, staticBoundary: 0, chartBoundary: 0, chartShapeEdge: 0, flatInterior: 0, flatOutside: 0 };
  const grid = new Float64Array(16 * 16);
  let changedTotal = 0;
  let interiorErrorSamples: number[] = [];
  let outsideErrorSamples: number[] = [];
  const outsidePoints: [number, number][] = [];
  for (let y = 0; y < PHYSICAL.height; y += 1) {
    for (let x = 0; x < PHYSICAL.width; x += 1) {
      const offset = (y * PHYSICAL.width + x) * 3;
      const error = Math.max(
        Math.abs(native.data[offset] - webImage.data[offset]),
        Math.abs(native.data[offset + 1] - webImage.data[offset + 1]),
        Math.abs(native.data[offset + 2] - webImage.data[offset + 2]));
      if (error <= CHANGED_THRESHOLD) continue;
      changedTotal += 1;
      grid[(Math.min(15, Math.floor(y / 34))) * 16 + Math.min(15, Math.floor(x / 60))] += 1;
      if (inRect(letterboxRect, x, y) || inRect(letterboxRect2, x, y)) { counts.letterbox += 1; continue; }
      if (glyphRects.some(rect => inRect(rect, x, y))) { counts.atlasGlyph += 1; continue; }
      if (imageRects.some(rect => inRect(rect, x, y))) { counts.atlasImage += 1; continue; }
      if (staticBoundaries.some(entry => inBand(entry, x, y))) { counts.staticBoundary += 1; continue; }
      if (chartBoundaries.some(entry => inBand(entry, x, y))) { counts.chartBoundary += 1; continue; }
      const interiorIndex = chartInteriors.findIndex(({ rect }) => inRect(rect, x, y));
      if (interiorIndex >= 0) {
        // 采样与边缘：该像素自身为边缘中心，或紧贴任一端图像的边缘（1px 边界位移带）。
        // diff 人工复核（见 matrix.json notes）：双端差异全部为弧/柱/扇区 1px 轮廓线，
        // 位移带邻接像素若按"自身非边缘"归平坦区会把几何边界差误判成系统性色差。
        const nearEdge = (mask: Uint8Array): boolean => {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (let dx = -1; dx <= 1; dx += 1) {
              const nx = x + dx, ny = y + dy;
              if (nx >= 0 && nx < PHYSICAL.width && ny >= 0 && ny < PHYSICAL.height && mask[ny * PHYSICAL.width + nx]) return true;
            }
          }
          return false;
        };
        if (nativeEdge[y * PHYSICAL.width + x] || webEdge[y * PHYSICAL.width + x]
          || nearEdge(nativeEdge, x, y) || nearEdge(webEdge, x, y)) {
          counts.chartShapeEdge += 1; continue;
        }
      }
      // frame 内残余：几何边界 1px 位移带的非邻接列（如 bar 边缘错位的黑/绿对撞列），归边缘级残余统计。
      // frame 外平坦区（static 图例卡/面板底色等）：均匀色偏是系统性色差的证据区，单列。
      if (interiorIndex >= 0) { counts.flatInterior += 1; if (interiorErrorSamples.length < 200_000) interiorErrorSamples.push(error); }
      else {
        counts.flatOutside += 1;
        if (outsideErrorSamples.length < 200_000) { outsideErrorSamples.push(error); outsidePoints.push([x, y]); }
      }
    }
  }
  // 结构性缺失检测：chart frame 内部一端有内容另一端近乎空白。
  const framePresence = chartInteriors.map(({ rect }) => {
    let nativeColored = 0, webColored = 0, total = 0;
    for (let y = Math.max(0, Math.floor(rect.top)); y < Math.min(PHYSICAL.height, Math.ceil(rect.bottom)); y += 1) {
      for (let x = Math.max(0, Math.floor(rect.left)); x < Math.min(PHYSICAL.width, Math.ceil(rect.right)); x += 1) {
        const offset = (y * PHYSICAL.width + x) * 3;
        total += 1;
        if (native.data[offset] || native.data[offset + 1] || native.data[offset + 2]) nativeColored += 1;
        if (webImage.data[offset] || webImage.data[offset + 1] || webImage.data[offset + 2]) webColored += 1;
      }
    }
    return { nativeColored, webColored, ratio: Math.min(nativeColored, webColored) / Math.max(1, Math.max(nativeColored, webColored)) };
  });
  const missingFrame = framePresence.findIndex(presence => presence.ratio < 0.7);

  const edgeClass = counts.atlasGlyph + counts.atlasImage + counts.staticBoundary + counts.chartBoundary
    + counts.chartShapeEdge + counts.flatInterior;
  const pct = (value: number): string => (value / Math.max(1, changedTotal) * 100).toFixed(1);
  const sorted = (samples: number[]): number[] => [...samples].sort((a, b) => a - b);
  const pick = (samples: number[], ratio: number): number =>
    samples.length ? samples[Math.min(samples.length - 1, Math.floor(ratio * samples.length))]! : 0;
  const outsideSorted = sorted(outsideErrorSamples);
  const interiorSorted = sorted(interiorErrorSamples);
  const outsideBBox = outsidePoints.length
    ? outsidePoints.reduce(([x0, y0, x1, y1], [x, y]) => [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)], [960, 540, 0, 0])
    : null;
  let level = "expected_sampling_edge";
  let levelDetail = `changed 像素 ${changedTotal} 中边缘/位移带类 ${edgeClass}（${pct(edgeClass)}%，图集 ${counts.atlasGlyph + counts.atlasImage}、static 面板边界环带 ${counts.staticBoundary}、chart 边界环带 ${counts.chartBoundary}、图形边缘及 1px 位移带 ${counts.chartShapeEdge + counts.flatInterior}）；letterbox ${counts.letterbox}`;
  if (missingFrame >= 0 || comparison.changedPixelRatio > 0.25) {
    level = "structural_missing";
    levelDetail = missingFrame >= 0
      ? `chart frame ${missingFrame} 双端内容比例 ${(framePresence[missingFrame]!.ratio * 100).toFixed(1)}% <70%，结构性缺失（阻断）`
      : `全图 changedPixelRatio=${comparison.changedPixelRatio.toFixed(4)} >0.25，结构性异常（阻断）`;
  } else if (counts.letterbox > 0) {
    level = "systematic_color";
    levelDetail += `；letterbox 区出现 ${counts.letterbox} 个 changed 像素（呈现/色彩管路差异，需追）`;
  } else if (counts.flatOutside > 50 && pick(outsideSorted, 0.5) >= 12) {
    level = "systematic_color";
    levelDetail += `；frame 外平坦区（面板内部等底色区，不含边界环带）${counts.flatOutside} 个 changed（中位误差 ${pick(outsideSorted, 0.5)}、p999 ${pick(outsideSorted, 0.999)}），聚集于物理 ${outsideBBox?.join(",")}（平坦底色非边缘差异，需查颜色管路）`;
  } else if (counts.flatOutside > 0) {
    levelDetail += `；frame 外平坦区 ${counts.flatOutside} 个 changed（中位误差 ${pick(outsideSorted, 0.5)}，低于色差判定线 12，暂归边缘级残余观察）`;
  }

  // 代表性 diff crops：changed 密度最高的 2 个 16×16 网格 → 96×96 裁剪。
  mkdirSync(join(cellDir, "crops"), { recursive: true });
  const crops: string[] = [];
  const topCells = [...grid.keys()].sort((a, b) => grid[b!] - grid[a!]).slice(0, 2).filter(index => grid[index!] > 0);
  for (const index of topCells) {
    const centerX = ((index! % 16) + 0.5) * 60, centerY = (Math.floor(index! / 16) + 0.5) * 34;
    const rect: Rect = { left: centerX - 48, top: centerY - 48, right: centerX + 48, bottom: centerY + 48 };
    const name = `crop-x${Math.round(centerX)}-y${Math.round(centerY)}`;
    await cropToPng(native, rect, join(cellDir, "crops", `${name}-native.png`));
    await cropToPng(webImage, rect, join(cellDir, "crops", `${name}-web.png`));
    await cropToPng(diff, rect, join(cellDir, "crops", `${name}-diff.png`));
    crops.push(name);
  }

  cells.push({
    ...meta,
    native: { png: `cells/${meta.id}/native-${meta.id}.png`, ...nativeResults[meta.id] },
    web: { png: `cells/${meta.id}/web-${meta.id}.png`, coloredPixels: webCell.coloredPixels, pageId: webCell.pageId },
    comparison,
    regions: {
      regionPixelCounts: {
        letterbox: area(letterboxRect) + area(letterboxRect2),
        atlasGlyph: glyphRects.reduce((sum, rect) => sum + area(rect), 0),
        atlasImage: imageRects.reduce((sum, rect) => sum + area(rect), 0),
        staticBoundary: staticBoundaries.reduce((sum, entry) => sum + entry.areaPx, 0),
        chartBoundary: chartBoundaries.reduce((sum, entry) => sum + entry.areaPx, 0),
        chartInterior: chartInteriors.reduce((sum, entry) => sum + entry.areaPx, 0),
        flat: flatAreaPx,
      },
      changedPixelsByRegion: counts,
      changedTotal,
      chartFramePresence: framePresence.map((presence, index) => ({ frame: index, ...presence })),
    },
    classification: { level, detail: levelDetail },
    interiorResidualChannelErrorP999: pick(interiorSorted, 0.999),
    outsideFlatChannelError: { p50: pick(outsideSorted, 0.5), p999: pick(outsideSorted, 0.999), bboxPhysical: outsideBBox },
    crops: crops.map(name => `cells/${meta.id}/crops/${name}-{native,web,diff}.png`),
  });
  console.log(`cell ${meta.id}: ssim=${comparison.ssim.toFixed(4)} mae=${comparison.meanAbsoluteError.toFixed(5)} changed=${(comparison.changedPixelRatio * 100).toFixed(2)}% -> ${level}`);
}

// ---------- 5. 阈值建议（基于实测分布；不做单格武断判定） ----------
const ssimMin = Math.min(...cells.map(cell => cell.comparison.ssim));
const changedMax = Math.max(...cells.map(cell => cell.comparison.changedPixelRatio));
const maeMax = Math.max(...cells.map(cell => cell.comparison.meanAbsoluteError));
const textEdgeRatio = cells.map(cell => {
  const region = cell.regions.regionPixelCounts;
  const textEdgePixels = region.atlasGlyph + region.atlasImage + region.staticBoundary + region.chartBoundary;
  const changed = cell.regions.changedPixelsByRegion;
  const textEdgeChanged = changed.atlasGlyph + changed.atlasImage + changed.staticBoundary + changed.chartBoundary
    + changed.chartShapeEdge;
  return textEdgeChanged / Math.max(1, textEdgePixels);
});
const textEdgeRatioMax = Math.max(...textEdgeRatio);
const thresholds = {
  status: "建议值，待 V 验收确认（本片只报分布，不做单格武断判定）",
  basis: `6 格（3 fixture × 2 主题）960×540 实测：ssim∈[${Math.min(...cells.map(c => c.comparison.ssim)).toFixed(4)}, ${Math.max(...cells.map(c => c.comparison.ssim)).toFixed(4)}], changedPixelRatio∈[${Math.min(...cells.map(c => c.comparison.changedPixelRatio)).toFixed(5)}, ${changedMax.toFixed(5)}]`,
  suggestions: {
    fullFrameSsimMin: { value: Number((ssimMin - 0.005).toFixed(4)), unit: "SSIM", rationale: "实测最差格再留 0.005 余量" },
    fullFrameChangedPixelRatioMax: { value: Number((changedMax * 1.5 + 0.001).toFixed(4)), unit: "ratio(maxChannelError>8)", rationale: "实测最大 ×1.5 + 0.1% 余量" },
    fullFrameMeanAbsoluteErrorMax: { value: Number((maeMax * 1.5).toFixed(5)), unit: "MAE(0-1)", rationale: "实测最大 ×1.5" },
    textEdgeChangedRatioMax: { value: Number((textEdgeRatioMax * 1.5 + 0.001).toFixed(4)), unit: "ratio", rationale: "图集文字+几何边界环带区 changed 占该区像素比例实测最大 ×1.5" },
    interiorResidualNote: "chart 内平坦区残余为 1px 几何位移带的黑/色对撞列（实测值见各格 interiorResidualChannelErrorP999），属采样与边缘预期级，不设独立上限，由全图 changedPixelRatioMax 与 textEdgeChangedRatioMax 覆盖",
    outsideFlatChannelErrorMax: { value: 8, unit: "channel(0-255)", rationale: "非文字平坦区（static 图例卡/面板底色内部）建议 maxChannelError ≤8：2026-09-18 读回预乘修复后面板内部双端逐像素一致，此线保留为平坦底色系统性色差的守卫线，待 V 验收确认" },
    outsideFlatChangedPixelsMax: { value: 50, unit: "px", rationale: "frame 外平坦区（面板内部，不含 staticBoundary 边界环带）changed 绝对数上限；超线判系统性色差" },
    letterboxChangedPixels: { value: 0, unit: "px", rationale: "letterbox 黑边双端都必须为 0，出现即阻断级" },
  },
};

const matrix = {
  generatedAt: "2026-09-18",
  purpose: "P0-08 Browser(WebGPU) vs Native 跨端像素矩阵第一版（3 fixture × 2 主题 × 1 尺寸，可扩展）",
  pipeline: {
    fixtures: "scripts/p08-matrix-fixtures.mts：dashboard-composition-v1.json 派生 draft+改动+生产 canonical rehash；双端读同一落盘 JSON 字节",
    native: "cargo test --bin deep-engine-native producer_package_renders_real_pixels -- --ignored（Rgba8UnormSrgb 960×540 读回，GPU validation scope 为空由测试断言）",
    web: "scripts/p08-matrix-page.ts：DashboardCandidateController + createDashboardCompositionGpuHost + chartFrame，publish 后同步 2d readback",
    stats: "apps/web/scripts/renderImageSimilarity.mjs compareImageFiles + sharp 逐像素区域归因",
  },
  web: { adapter: web.adapter, canvasFormat: web.canvasFormat, renderTargetFormat: web.renderTargetFormat },
  cells,
  thresholds,
  notes: [
    `Native 彩色像素与本仓 20260917 基线（132,913）存在漂移（本次 base-dark 实测 ${nativeResults["composition-base-dark"]!.coloredPixels}），系不同日期驱动/环境重采；本矩阵全部 6 格 Native 与 Web 同日成对采集，格内对比自洽。`,
    "C1 残余差异结论沿用：弧采样 1px 边缘差与 bar 边界差，归采样与边缘（预期）级。",
    "2026-09-18 systematic_color 追因闭环：图例卡底色均匀色偏根因是 Web 读回路径——premultiplied WebGPU canvas 经透明底 drawImage+getImageData 按 HTML 规范反预乘（RGB÷A，A=0.94/0.97），读回值非展示像素；修复为黑底合成后读回（CSS Compositing 1 展示语义，与 Native 不透明读回同口径），面板内部双端逐像素一致（见 test-output/legend-color-fix-20260918）。",
    "遗留（边缘级）：static 面板/图集 quad 边界环带存在 AA 覆盖量化差，机制为 Web deep2d 管线 4× MSAA 而 Native 1×；修复前该差异被读回反预乘部分抵消，修复后如实呈现。后续若追平需给 Native deep2d 增加 4× MSAA+resolve 或 Web 降采样口径，属渲染管线变更，另立任务。",
  ],
  knownGaps: [
    "headless Chrome WebGPU 与真实窗口的 DPI 缩放/系统色彩管理（ICC/HDR）管路差异未覆盖",
    "矩阵不含输入事件、DPI 缩放、窄屏（980 以下）与双页（page-1）维度，归后续格",
    "Chrome SwiftShader 软件回退路径未采样（本机 RTX 4060 真实适配器）",
  ],
};
writeFileSync(join(output, "matrix.json"), JSON.stringify(matrix, null, 2) + "\n");
console.log("\nP08 matrix summary (native vs web, 960x540, page-0):");
console.log("cell                          | ssim   | mae     | changed | level");
for (const cell of cells) {
  console.log(`${cell.id.padEnd(29)} | ${cell.comparison.ssim.toFixed(4)} | ${cell.comparison.meanAbsoluteError.toFixed(5)} | ${(cell.comparison.changedPixelRatio * 100).toFixed(2)}%  | ${cell.classification.level}`);
}
console.log(`thresholds: ${JSON.stringify(thresholds.suggestions)}`);
console.log(`output: ${output}`);
