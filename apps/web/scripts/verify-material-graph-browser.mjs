import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// 材质图(编辑器刀 7)·真实浏览器证据脚本。
// 流程:vite dev server → 真 ViewerEngine 夹具页 → 面板真实点击
// (开面板 → 加磨损层 → 加灰尘层 → 点选层节点 → 接管对象材质)→
// 断言引擎读回材质(合成色/ORM/法线 dataURL + 标量置 1)→ 编译确定性(页内)
// → 深浅主题各一轮截图;留存 report JSON 与 console 错误清单。

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const outputRoot = resolve(repositoryRoot, "test-output/material-graph-blade7-20261004");
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
console.log(`[material-graph-qa] vite dev server at ${origin}`);

const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const report = { createdAt: new Date().toISOString(), origin, steps: [], assertions: {}, screenshots: [], consoleErrors: [] };

function record(step, ok, detail) {
  report.steps.push({ step, ok, detail });
  console.log(`[material-graph-qa] ${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`步骤失败:${step}${detail ? `:${detail}` : ""}`);
}

async function runTheme(theme) {
  const page = await browser.newPage({ viewport: { width: 1560, height: 940 } });
  page.on("console", message => { if (message.type() === "error") report.consoleErrors.push(`${theme}: ${message.text()}`); });
  page.on("pageerror", error => report.consoleErrors.push(`${theme}: pageerror ${String(error)}`));
  page.on("response", response => { if (response.status() >= 400) report.consoleErrors.push(`${theme}: HTTP ${response.status()} ${response.url()}`); });
  await page.goto(`${origin}/tests/material-graph-browser.html?theme=${theme}`);
  // 引擎就绪:状态行出现"引擎:就绪"
  await page.waitForFunction(() => document.querySelector('[data-qa="qa-report"]')?.textContent?.includes("引擎:就绪"), { timeout: 90_000 });
  record(`[${theme}] 夹具页就绪(真 ViewerEngine WebGL + 验收盒)`, true);

  // 打开材质图面板
  await page.click('[data-qa="material-graph-editor"] summary');
  await page.waitForSelector('[data-qa="material-graph-add-wear"]', { timeout: 10_000 });
  record(`[${theme}] 材质图面板展开,加层按钮可见`, true);

  // 空图状态:未接管
  const statusBefore = await page.textContent('[data-qa="material-graph-status"]');
  record(`[${theme}] 初始状态为未接管`, Boolean(statusBefore?.includes("未接管")), statusBefore ?? "");

  // 加两层:磨损 + 灰尘
  await page.click('[data-qa="material-graph-add-wear"]');
  await page.click('[data-qa="material-graph-add-dust"]');
  await page.waitForFunction(() => document.querySelector('[data-qa="material-graph-editor"] summary small')?.textContent?.startsWith("2/4"), { timeout: 10_000 });
  record(`[${theme}] 两层图搭建(磨损+灰尘),计数 2/4`, true);

  // 点选层节点(画布真实点击第一层节点)
  await page.click('[data-node-id][data-node-kind="layer"]');
  await page.waitForSelector('[data-qa="material-graph-props-layer"]', { timeout: 10_000 });
  record(`[${theme}] 点选层节点,属性表单出现`, true);

  // 页内编译确定性验收
  await page.click('[data-qa="qa-auto"]');
  await page.waitForFunction(() => document.querySelector('[data-qa="qa-report"]')?.textContent?.includes("字节相等"), { timeout: 20_000 });
  const qa = await page.evaluate(() => window.__materialGraphQa.get());
  record(`[${theme}] 同图两次编译逐字节相等(浏览器侧确定性)`, qa.determinismBytesEqual === true, `compile=${qa.compileMs}ms`);

  // 接管对象材质 → 引擎材质事实断言
  const applyStart = Date.now();
  await page.click('[data-qa="material-graph-link"]');
  await page.waitForFunction(() => document.querySelector('[data-qa="material-graph-status"]')?.textContent?.includes("已接管"), { timeout: 20_000 });
  const facts = await page.textContent('[data-qa="material-facts"]');
  const linked = await page.evaluate(() => window.__materialGraphQa.get());
  record(`[${theme}] 接管完成(状态=已接管)`, true, `${Date.now() - applyStart}ms 内`);
  record(`[${theme}] 合成色贴图写入 baseColorMapUrl(dataURL)`, facts.includes("baseColorMapUrl: data:image"), facts.slice(0, 80));
  record(`[${theme}] ORM 打包图同时写入粗糙度+金属度槽`, facts.includes("roughnessMapUrl: 已设置") && facts.includes("metalnessMapUrl: 已设置"));
  record(`[${theme}] 凹凸法线写入 normalMapUrl`, facts.includes("normalMapUrl: 已设置"));
  record(`[${theme}] 接管标量置 1(three 贴图×标量语义)`, linked.scalarRoughness === 1 && linked.scalarMetalness === 1,
    `rough=${linked.scalarRoughness} metal=${linked.scalarMetalness}`);
  record(`[${theme}] 引擎应用延迟 <100ms(预合成红线)`, linked.applyLatencyMs < 100, `${linked.applyLatencyMs}ms`);
  record(`[${theme}] 编译耗时 <100ms(256² 两层)`, linked.compileMs < 100, `${linked.compileMs}ms`);

  // 断开图还原 → 贴图槽清空
  await page.click('[data-qa="material-graph-link"]');
  await page.waitForFunction(() => document.querySelector('[data-qa="material-graph-status"]')?.textContent?.includes("未接管"), { timeout: 20_000 });
  const factsAfter = await page.textContent('[data-qa="material-facts"]');
  record(`[${theme}] 断开图还原:贴图槽清空、回到原材质`, factsAfter.includes("baseColorMapUrl: —") && factsAfter.includes("roughnessMapUrl: —"));

  const shot = resolve(outputRoot, `material-graph-${theme}.png`);
  await page.screenshot({ path: shot, fullPage: true });
  report.screenshots.push(shot);
  console.log(`[material-graph-qa] 截图 ${shot}`);
  await page.close();
  return { facts, linked };
}

try {
  const dark = await runTheme("dark");
  const light = await runTheme("light");
  report.assertions = {
    determinismBytesEqual: dark.linked.determinismBytesEqual && light.linked.determinismBytesEqual,
    applyLatencyMs: dark.linked.applyLatencyMs,
    compileMs: dark.linked.compileMs,
    restoreWorks: true,
  };
  const fatalConsole = report.consoleErrors.filter(text => !text.includes("WebGPU") && !text.includes("favicon"));
  record("无致命 console 错误", fatalConsole.length === 0, fatalConsole.slice(0, 3).join(" | "));
} finally {
  writeFileSync(resolve(outputRoot, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await vite.close();
}
console.log(`[material-graph-qa] 全部通过,证据目录 ${outputRoot}`);
