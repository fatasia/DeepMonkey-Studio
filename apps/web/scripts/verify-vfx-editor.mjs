import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// VFX 图编辑器(编辑器刀 8)·真实浏览器证据脚本。
// 流程:vite dev server → 真 ViewerEngine 夹具页 → 面板真实点击
// (挂告警环模板 → 键盘调速率/强度 → 切火花模板 → 画布像素差分 → 行为等价触发 → 移除图层)→
// 断言引擎读回状态与独立预算池事实 → 深浅主题各一轮截图;
// 留存 report JSON 与 console 错误清单。

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const outputRoot = resolve(repositoryRoot, "test-output/vfx-editor-blade8-20261004");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!existsSync(chromePath)) throw new Error(`Chrome 不存在:${chromePath}`);
mkdirSync(outputRoot, { recursive: true });

// wasm 资产就位(dev server 与生产一致的 public/dev/pkg)
execFileSync(process.execPath, [resolve(webRoot, "scripts/copy-wasm.mjs")], { stdio: "inherit" });

const { createServer: createViteServer } = await import("vite");
const vite = await createViteServer({
  root: webRoot,
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "error",
  server: { port: 0, strictPort: false },
});
await vite.listen();
const localUrl = vite.resolvedUrls?.local?.[0];
const origin = localUrl ? new URL(localUrl).origin : `http://127.0.0.1:${vite.config.server.port ?? 5173}`;
console.log(`[vfx-qa] vite dev server at ${origin}`);

const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const report = { createdAt: new Date().toISOString(), origin, steps: [], assertions: {}, screenshots: [], consoleErrors: [] };

function record(step, ok, detail) {
  report.steps.push({ step, ok, detail });
  console.log(`[vfx-qa] ${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`步骤失败:${step}${detail ? `:${detail}` : ""}`);
}

async function diffPixels(pathA, pathB) {
  const sharp = (await import("sharp")).default;
  const [rawA, rawB] = await Promise.all([
    sharp(pathA).raw().toBuffer({ resolveWithObject: true }),
    sharp(pathB).raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (rawA.info.width !== rawB.info.width || rawA.info.height !== rawB.info.height) {
    return { changed: 0, threshold: 0, total: 0 };
  }
  let changed = 0;
  const total = rawA.info.width * rawA.info.height;
  for (let offset = 0; offset < rawA.data.length; offset += rawA.info.channels) {
    const delta = Math.abs(rawA.data[offset] - rawB.data[offset])
      + Math.abs(rawA.data[offset + 1] - rawB.data[offset + 1])
      + Math.abs(rawA.data[offset + 2] - rawB.data[offset + 2]);
    if (delta > 24) changed += 1;
  }
  return { changed, threshold: Math.floor(total * 0.002), total };
}

async function runTheme(theme) {
  const page = await browser.newPage({ viewport: { width: 1560, height: 940 } });
  page.on("console", message => { if (message.type() === "error") report.consoleErrors.push(`${theme}: ${message.text()}`); });
  page.on("pageerror", error => report.consoleErrors.push(`${theme}: pageerror ${String(error)}`));
  page.on("response", response => { if (response.status() >= 400) report.consoleErrors.push(`${theme}: HTTP ${response.status()} ${response.url()}`); });
  await page.goto(`${origin}/tests/vfx-editor-browser.html?theme=${theme}`);
  await page.waitForFunction(() => document.querySelector('[data-qa="qa-report"]')?.textContent?.includes("引擎:就绪"), { timeout: 90_000 });
  record(`[${theme}] 夹具页就绪(真 ViewerEngine WebGL + 验收罐/验收柱)`, true);

  // 1) 面板真实点击:挂告警脉冲环模板
  await page.click('[data-qa="vfx-template-alarm-ring"]');
  await page.waitForSelector('[data-qa="vfx-fields"]', { timeout: 10_000 });
  let qa = await page.evaluate(() => window.__vfxQa.get());
  record(`[${theme}] 点击模板卡挂载告警环(引擎读回 template=alarm-ring)`, qa.vfxTemplate === "alarm-ring" && qa.vfxEnabled === true,
    `template=${qa.vfxTemplate} enabled=${qa.vfxEnabled}`);
  record(`[${theme}] VFX 独立预算池出现发射器(运行时已创建)`, qa.vfxEmitters >= 1 && qa.vfxRequested > 0,
    `emitters=${qa.vfxEmitters} requested=${qa.vfxRequested}`);
  const initialRequested = qa.vfxRequested;

  // 2) 真实键盘交互:聚焦速率滑杆,ArrowUp ×2(rate 1 → 1.1 → 1.2)
  await page.focus('[data-qa="vfx-rate"] input[type="range"]');
  for (let index = 0; index < 2; index += 1) await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => (window.__vfxQa?.get().vfxRate ?? 0) > 1.05, { timeout: 10_000 });
  qa = await page.evaluate(() => window.__vfxQa.get());
  record(`[${theme}] 键盘调速率滑杆后引擎读回 rate 变化`, qa.vfxRate > 1.05, `rate=${qa.vfxRate}`);
  record(`[${theme}] 预算申请量随速率变化(参数直通引擎预算)`, qa.vfxRequested !== initialRequested,
    `requested ${initialRequested} → ${qa.vfxRequested}`);

  // 3) 强度滑杆:ArrowUp ×1 → intensity 变化
  await page.focus('[data-qa="vfx-intensity"] input[type="range"]');
  await page.keyboard.press("ArrowUp");
  await page.waitForFunction(() => (window.__vfxQa?.get().vfxIntensity ?? 0) > 1.85, { timeout: 10_000 });
  qa = await page.evaluate(() => window.__vfxQa.get());
  record(`[${theme}] 强度滑杆直通引擎(intensity 1.8 → ${qa.vfxIntensity})`, qa.vfxIntensity > 1.85);

  // 4) 切换模板:告警环 → 火花迸溅(叠加混合)→ 切回告警环(差分用大半径环)。
  await page.click('[data-qa="vfx-template-sparks"]');
  await page.waitForFunction(() => window.__vfxQa?.get().vfxTemplate === "sparks", { timeout: 10_000 });
  qa = await page.evaluate(() => window.__vfxQa.get());
  record(`[${theme}] 一键切换到火花模板(引擎读回 template=sparks)`, qa.vfxTemplate === "sparks", `blend=${qa.vfxBlend}`);
  await page.click('[data-qa="vfx-template-alarm-ring"]');
  await page.waitForFunction(() => window.__vfxQa?.get().vfxTemplate === "alarm-ring", { timeout: 10_000 });

  // 5) 粒子可见性:画布像素差分(此时画布上只有验收罐的告警环)。
  //    用"启用开关"而不是"移除"做关侧:移除会收起参数面板 → 画布 resize 重投影,
  //    布局差异会淹没粒子差异;开关只改 enabled,布局不变,差分即纯粒子。
  const canvasClip = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: Math.min(rect.width, 1000), height: Math.min(rect.height, 900) };
  });
  await page.waitForTimeout(500);
  const shotOn = resolve(outputRoot, `vfx-on-${theme}.png`);
  await page.screenshot({ path: shotOn, ...(canvasClip ? { clip: canvasClip } : {}) });
  report.screenshots.push(shotOn);
  await page.click('[data-qa="vfx-toggle"]');
  await page.waitForFunction(() => window.__vfxQa?.get().vfxEnabled === false, { timeout: 10_000 });
  await page.waitForTimeout(400);
  const shotOff = resolve(outputRoot, `vfx-off-${theme}.png`);
  await page.screenshot({ path: shotOff, ...(canvasClip ? { clip: canvasClip } : {}) });
  report.screenshots.push(shotOff);
  const pixelDiff = await diffPixels(shotOn, shotOff);
  record(`[${theme}] 关闭启用开关后引擎读回 enabled=false`, true);
  record(`[${theme}] 画布像素差分证明粒子真实渲染`, pixelDiff.changed > pixelDiff.threshold && pixelDiff.total > 0,
    `changed=${pixelDiff.changed}px threshold=${pixelDiff.threshold} total=${pixelDiff.total}`);

  // 6) 移除图层 → 引擎读回 undefined;行为等价触发验收柱 → 模板默认参数基线;再挂回告警环。
  await page.click('[data-qa="vfx-detach"]');
  await page.waitForFunction(() => window.__vfxQa?.get().vfxTemplate === undefined, { timeout: 10_000 });
  record(`[${theme}] 移除 VFX 图层后引擎读回 vfx=undefined`, true);
  await page.click('[data-qa="qa-behavior"]');
  await page.waitForFunction(() => window.__vfxQa?.get().behaviorTriggered === true, { timeout: 10_000 });
  await page.click('[data-qa="vfx-template-alarm-ring"]');
  await page.waitForFunction(() => window.__vfxQa?.get().vfxTemplate === "alarm-ring", { timeout: 10_000 });
  qa = await page.evaluate(() => window.__vfxQa.get());
  record(`[${theme}] 行为等价触发验收柱告警环(template=alarm-ring, enabled=true)`,
    qa.behaviorTriggered && qa.behaviorTemplate === "alarm-ring" && qa.behaviorEnabled === true);
  record(`[${theme}] 行为触发后场景出现两个 VFX 发射器`, qa.vfxEmitters >= 2, `emitters=${qa.vfxEmitters}`);

  // 7) 面板全图截图(深浅主题各一)
  const fullShot = resolve(outputRoot, `vfx-panel-${theme}.png`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: fullShot, fullPage: true });
  report.screenshots.push(fullShot);
  console.log(`[vfx-qa] 截图 ${fullShot}`);
  await page.close();
  return { qa };
}

try {
  const dark = await runTheme("dark");
  const light = await runTheme("light");
  report.assertions = {
    darkTemplate: dark.qa.vfxTemplate,
    lightTemplate: light.qa.vfxTemplate,
    behaviorEmitters: dark.qa.vfxEmitters,
  };
  const fatalConsole = report.consoleErrors.filter(text => !text.includes("WebGPU") && !text.includes("favicon"));
  record("无致命 console 错误", fatalConsole.length === 0, fatalConsole.slice(0, 3).join(" | "));
} finally {
  writeFileSync(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await vite.close();
}
console.log(`[vfx-qa] 全部通过,证据目录 ${outputRoot}`);
