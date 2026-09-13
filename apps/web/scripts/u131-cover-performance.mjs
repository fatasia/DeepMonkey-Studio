// u131 真实渲染封面全量铺开 + 性能取证(非正式门禁,产出 JSON 报告 + 特写截图)。
// 流程:登录 → 编辑场景 → 资源 tab → 打开看板模板库 → 分段滚动遍历全部模板
//       → 统计真渲染覆盖率/回退清单 → longtask/内存取证 → 12 跨域特写 → light 主题抽验。
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const output = resolve("test-output/cover-performance");
mkdirSync(output, { recursive: true });

const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(String(error?.message ?? error)));

await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2500);
// 已登录则跳过登录
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
}

// 注入 longtask 观察器(打开模板库前 reset,取证仅覆盖遍历窗口)
await page.evaluate(() => {
  const sink = { count: 0, totalBlockingMs: 0, maxDurationMs: 0, samples: [] };
  window.__u131LongTask = sink;
  window.__u131LongTaskReset = () => {
    sink.count = 0; sink.totalBlockingMs = 0; sink.maxDurationMs = 0; sink.samples.length = 0;
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        sink.count += 1;
        sink.totalBlockingMs += Math.max(0, entry.duration - 50);
        sink.maxDurationMs = Math.max(sink.maxDurationMs, entry.duration);
        if (sink.samples.length < 40) sink.samples.push({ at: Math.round(entry.startTime), durationMs: Math.round(entry.duration) });
      }
    }).observe({ entryTypes: ["longtask"] });
  } catch { /* 旧内核无 longtask 时如实记录 0 */ }
});

// 进入编辑场景 → 资源 tab
await page.getByRole("button", { name: "编辑场景" }).first().click();
await page.waitForTimeout(5000);
const resourceTab = page.getByRole("button", { name: /^资源$/ }).first();
if (await resourceTab.count()) await resourceTab.click();
await page.waitForTimeout(2500);

// 内存基线:打开模板库之前
const memoryBaseline = await page.evaluate(() => ({
  usedJSHeapSize: performance.memory?.usedJSHeapSize ?? 0,
  totalJSHeapSize: performance.memory?.totalJSHeapSize ?? 0,
}));

// 打开模板库,首屏时间 = 点击到首屏卡片可见
await page.evaluate(() => window.__u131LongTaskReset());
const openStartedAt = Date.now();
await page.locator(".dashboard-library-template-button").first().click();
await page.locator(".dashboard-template-grid article .dashboard-template-card-preview").first().waitFor({ timeout: 30000 });
const firstPaintMs = Date.now() - openStartedAt;
await page.waitForTimeout(2500); // 等首轮 SVG 布局稳定

// 分段滚动遍历:每次滚一屏,让 IntersectionObserver(rootMargin 320px)把全部卡片入队
const body = page.locator(".dashboard-template-body").first();
const scrollStartedAt = Date.now();
let lastScrollTop = -1;
for (let step = 0; step < 400; step += 1) {
  const atBottom = await body.evaluate((element) => {
    element.scrollTop += element.clientHeight * 0.85;
    return element.scrollTop + element.clientHeight >= element.scrollHeight - 4;
  });
  if (atBottom) break;
  if (await body.evaluate((element) => element.scrollTop) === lastScrollTop) break;
  lastScrollTop = await body.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(280);
}
const scrollDoneMs = Date.now() - scrollStartedAt;

// 等待串行渲染队列消化:img 数量连续多次稳定即就绪(上限 9 分钟)
let stableRounds = 0;
let previousCount = -1;
const queueStartedAt = Date.now();
let coverCount = 0;
for (;;) {
  coverCount = await page.evaluate(() => document.querySelectorAll("img.dashboard-template-cover-photo").length);
  if (coverCount === previousCount) stableRounds += 1; else stableRounds = 0;
  previousCount = coverCount;
  if (stableRounds >= 4) break;
  if (Date.now() - queueStartedAt > 9 * 60_000) break;
  await page.waitForTimeout(4000);
}
const fullTraverseMs = Date.now() - openStartedAt;
const queueDrainMs = Date.now() - queueStartedAt;
await page.waitForTimeout(1500);

// 覆盖统计(按 aria-label 去重:推荐分区与全部网格可能重复同一模板)
const coverage = await page.evaluate(() => {
  const seen = new Map();
  for (const preview of document.querySelectorAll(".dashboard-template-card-preview")) {
    const label = preview.getAttribute("aria-label") ?? preview.parentElement?.textContent?.slice(0, 40) ?? "unknown";
    if (seen.has(label)) continue;
    const hasPhoto = Boolean(preview.querySelector("img.dashboard-template-cover-photo"));
    const nodeTypes = [...preview.querySelectorAll("g[data-widget-type]")].map((g) => g.getAttribute("data-widget-type"));
    const primaryNode = [...preview.querySelectorAll("g[data-template-node]")].find((g) => g.getAttribute("data-template-node")?.includes(".primary."));
    const primaryType = primaryNode?.getAttribute("data-widget-type") ?? nodeTypes[0] ?? "";
    const title = preview.parentElement?.querySelector("strong")?.textContent ?? label;
    const category = preview.parentElement?.querySelector("small")?.textContent ?? "";
    seen.set(label, { label, title, category, hasPhoto, primaryType, isMapPrimary: primaryType === "map" });
  }
  const items = [...seen.values()];
  return {
    uniqueTemplates: items.length,
    realCovered: items.filter((item) => item.hasPhoto).length,
    legalMapFallback: items.filter((item) => !item.hasPhoto && item.isMapPrimary).length,
    failures: items.filter((item) => !item.hasPhoto && !item.isMapPrimary).map((item) => ({ title: item.title, category: item.category, primaryType: item.primaryType })),
    mapPrimaries: items.filter((item) => item.isMapPrimary).length,
  };
});

// 分阶段耗时分布(运行时 __templateCoverPerf 环形 50 条)
const stages = await page.evaluate(() => {
  const rows = window.__templateCoverPerf ?? [];
  const pick = (values) => {
    if (!values.length) return { p50: 0, p95: 0, max: 0, n: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    return { p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0, max: sorted.at(-1) ?? 0, n: values.length };
  };
  return {
    sampleCount: rows.length,
    mountMs: pick(rows.map((row) => row.mountMs)),
    readyMs: pick(rows.map((row) => row.readyMs)),
    captureMs: pick(rows.map((row) => row.captureMs)),
    totalMs: pick(rows.map((row) => row.mountMs + row.readyMs + row.captureMs)),
  };
});

const longTasks = await page.evaluate(() => {
  const sink = window.__u131LongTask;
  return { count: sink.count, totalBlockingMs: Math.round(sink.totalBlockingMs), maxDurationMs: Math.round(sink.maxDurationMs), samples: sink.samples.slice(0, 40) };
});
const memoryFinal = await page.evaluate(() => ({
  usedJSHeapSize: performance.memory?.usedJSHeapSize ?? 0,
  totalJSHeapSize: performance.memory?.totalJSHeapSize ?? 0,
}));

// 全景截图(遍历完成态,顶部)
await page.screenshot({ path: resolve(output, "traverse-top-dark.png") });

// 12 个跨域模板特写:按 category 分组轮流取样,滚动到卡片后截图 + 像素多样性校验
const samplePool = await page.evaluate(() => {
  const byCategory = new Map();
  for (const preview of document.querySelectorAll(".dashboard-template-card-preview")) {
    if (!preview.querySelector("img.dashboard-template-cover-photo")) continue;
    const title = preview.parentElement?.querySelector("strong")?.textContent ?? "";
    const category = preview.parentElement?.querySelector("small")?.textContent ?? "";
    if (!title || byCategory.has(`${category}::${title}`)) continue;
    byCategory.set(`${category}::${title}`, { title, category });
  }
  // 轮流从每个类目取一张,直到 12 张
  const groups = [...byCategory.values()].reduce((acc, item) => {
    (acc[item.category] ??= []).push(item);
    return acc;
  }, {});
  const picked = [];
  let round = 0;
  while (picked.length < 12 && Object.values(groups).some((list) => list.length > round)) {
    for (const list of Object.values(groups)) {
      if (picked.length >= 12) break;
      if (list[round]) picked.push(list[round]);
    }
    round += 1;
  }
  return picked;
});

const sampleResults = [];
for (const [index, sample] of samplePool.entries()) {
  const card = page.locator("article", { has: page.locator(".dashboard-template-card-preview") }).filter({
    has: page.getByRole("strong", { name: sample.title }).or(page.locator(`strong[title*="${sample.title}"]`)),
  }).first();
  const article = page.locator("article").filter({ has: page.locator(`strong:text-is("${sample.title}")`) }).first();
  const target = (await article.count()) ? article : card;
  try {
    await target.scrollIntoViewIfNeeded({ timeout: 8000 });
    await page.waitForTimeout(700);
    await target.screenshot({ path: resolve(output, `sample-${String(index).padStart(2, "0")}.png`) });
  } catch (error) {
    sampleResults.push({ ...sample, error: String(error).slice(0, 120) });
    continue;
  }
  const pixels = await target.evaluate((element) => {
    const image = element.querySelector("img.dashboard-template-cover-photo");
    if (!image) return { hasPhoto: false, nonBlankRatio: 0 };
    const canvas = document.createElement("canvas");
    const width = 96, height = 54;
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    let varied = 0;
    for (let pixel = 0; pixel < data.length; pixel += 4) {
      const luminance = 0.2126 * data[pixel] + 0.7152 * data[pixel + 1] + 0.0722 * data[pixel + 2];
      if (luminance > 26 && luminance < 232) varied += 1;
    }
    return { hasPhoto: true, nonBlankRatio: Number((varied / (data.length / 4)).toFixed(3)) };
  });
  sampleResults.push({ ...sample, ...pixels });
}

// light 主题抽验:切主题 → 缓存清空 → 可视区卡片重新真渲染(同运行时同主题)
await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
await page.waitForTimeout(1200);
let lightStable = 0;
let lightPrevious = -1;
let lightCount = 0;
for (;;) {
  lightCount = await page.evaluate(() => document.querySelectorAll("img.dashboard-template-cover-photo").length);
  if (lightCount === lightPrevious) lightStable += 1; else lightStable = 0;
  lightPrevious = lightCount;
  if (lightStable >= 3) break;
  if (lightCount === 0 && lightStable >= 3) break;
  await page.waitForTimeout(3000);
  if (lightStable === 0 && lightPrevious === 0) { /* 尚未开始渲染,继续等 */ }
}
await page.waitForTimeout(2000);
const lightRound = await page.evaluate(() => {
  const previews = [...document.querySelectorAll(".dashboard-template-card-preview")].filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top < window.innerHeight && rect.bottom > 0 && rect.width > 0;
  });
  return {
    visibleCards: previews.length,
    visibleWithPhoto: previews.filter((element) => element.querySelector("img.dashboard-template-cover-photo")).length,
    totalPhotos: document.querySelectorAll("img.dashboard-template-cover-photo").length,
  };
});
await page.screenshot({ path: resolve(output, "light-theme-check.png") });
// 恢复深色主题,不污染后续会话状态
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

const report = {
  meta: {
    generatedAt: new Date().toISOString(),
    origin,
    viewport: "1600x900",
    themeRound: ["dark-full", "light-sample"],
    pageErrors,
  },
  totals: {
    ...coverage,
    coverageRate: coverage.uniqueTemplates ? Number((coverage.realCovered / coverage.uniqueTemplates).toFixed(4)) : 0,
    failureRate: coverage.uniqueTemplates ? Number(((coverage.failures.length) / coverage.uniqueTemplates).toFixed(4)) : 0,
  },
  perf: {
    firstPaintMs,
    scrollTraverseMs: scrollDoneMs,
    queueDrainMs,
    fullTraverseMs,
    longTasks,
    memory: {
      baselineHeapMB: Number((memoryBaseline.usedJSHeapSize / 1048576).toFixed(1)),
      finalHeapMB: Number((memoryFinal.usedJSHeapSize / 1048576).toFixed(1)),
      deltaHeapMB: Number(((memoryFinal.usedJSHeapSize - memoryBaseline.usedJSHeapSize) / 1048576).toFixed(1)),
      finalTotalHeapMB: Number((memoryFinal.totalJSHeapSize / 1048576).toFixed(1)),
    },
    stages,
  },
  samples: sampleResults,
  lightThemeRound: lightRound,
};

writeFileSync(resolve(output, "cover-performance.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  totals: report.totals,
  perf: report.perf,
  samplesOk: sampleResults.filter((sample) => sample.nonBlankRatio > 0.05).length,
  lightThemeRound: lightRound,
}, null, 1));
await browser.close();
