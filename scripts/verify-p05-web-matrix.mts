// P0-05 矩阵验证 Node 驱动：esbuild 打包矩阵页 → 本机 Chrome(真实 WebGPU) 运行
// 连续换包 / 迟到候选 / 取消 三组矩阵 → 落盘 result.json + 关键帧 PNG。
// 不复用 C1 输出目录；不改动 packages 生产源码。用法:
// node_modules/.bin/tsx scripts/verify-p05-web-matrix.mts
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dirname, "..");
const output = resolve(repo, "test-output/p05-web-matrix-20260918");
const fixturePath = resolve(repo, "packages/deep-engine/fixtures/dashboard-composition-v1.json");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

function fail(message: string): never { console.error(`P05-WEB-MATRIX FAIL: ${message}`); process.exit(1); }
if (!existsSync(chromePath)) fail(`Chrome 不存在: ${chromePath}（可用 BIM_STUDIO_CHROME_PATH 覆盖）`);
if (!existsSync(fixturePath)) fail(`fixture 缺失: ${fixturePath}`);

// 1. esbuild 打包矩阵页（conditions: development 让 @bim-studio/deep-engine 走 src 源码，与 C1 同口径）。
const requireFrom = (segment: string) => createRequire(join(repo, segment, "package.json"));
const { build } = requireFrom("apps/api")("esbuild") as typeof import("esbuild");
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
await build({ absWorkingDir: repo, entryPoints: ["scripts/verify-p05-web-matrix-page.ts"],
  outfile: join(output, "page.js"), bundle: true, platform: "browser", format: "esm",
  conditions: ["development"], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });

// 2. playwright-core 取 .pnpm 下固定安装（根依赖未声明，不硬编码版本号）。
const pnpmRoot = join(repo, "node_modules/.pnpm");
const pwDirName = readdirSync(pnpmRoot).find(name => name.startsWith("playwright-core@"));
if (!pwDirName) fail("node_modules/.pnpm 下未找到 playwright-core");
const { chromium } = await import(pathToFileURL(join(pnpmRoot, pwDirName, "node_modules/playwright-core/index.mjs")).href);

// 3. 静态服务：矩阵页 + fixture（页面内 fetch，与 C1 读同一 fixture 文件）。
const pageJs = readFileSync(join(output, "page.js"));
const fixtureBytes = readFileSync(fixturePath);
const html = `<!doctype html><html><head><meta charset="utf-8"><title>P05 web matrix verify</title></head>
<body><script type="module" src="/page.js"></script></body></html>`;
writeFileSync(join(output, "page.html"), html + "\n");
const server = createServer((request, response) => {
  const path = request.url?.split("?")[0] ?? "/";
  const body = path === "/page.js" ? { type: "text/javascript; charset=utf-8", data: pageJs }
    : path === "/fixture.json" ? { type: "application/json; charset=utf-8", data: fixtureBytes }
    : path === "/page.html" ? { type: "text/html; charset=utf-8", data: Buffer.from(html) } : null;
  if (!body) { response.writeHead(404).end("not found"); return; }
  response.setHeader("content-type", body.type);
  response.end(body.data);
});
await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

// 4. 真实浏览器 WebGPU 运行矩阵；失败时页面回传精确 stage/message，此处 exit 1，不降级。
const browser = await chromium.launch({ executablePath: chromePath, headless: true,
  args: ["--enable-unsafe-webgpu"] });
let result: any;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", error => console.error("pageerror:", String(error).slice(0, 400)));
  page.on("requestfailed", request => console.error("requestfailed:", request.url(), request.failure()?.errorText));
  page.on("response", response => { if (response.status() >= 400) console.error(`http ${response.status()}:`, response.url()); });
  page.on("console", message => console.error(`console.${message.type()}:`, message.text().slice(0, 400)));
  await page.goto(baseUrl + "/page.html" + (process.env.P05_ONLY ? `?only=${process.env.P05_ONLY}` : ""),
    { waitUntil: "load", timeout: 30_000 });
  try {
    await page.waitForFunction(() => (window as any).__P05_RESULT !== undefined, null, { timeout: 180_000 });
  } catch (error) {
    console.error("diagnostics:", await page.evaluate(() => ({
      readyState: document.readyState, scripts: [...document.scripts].map(script => script.src),
      bodyChildren: document.body.childElementCount, result: (window as any).__P05_RESULT ?? null })),
      String(error).slice(0, 200));
    throw error;
  }
  result = await page.evaluate(() => (window as any).__P05_RESULT);
} finally {
  await browser.close();
  server.close();
}
if (!result || typeof result.ok !== "boolean") {
  fail(`矩阵页无有效结果（stage=${result?.stage ?? "?"}）: ${result?.message ?? JSON.stringify(result)?.slice(0, 400)}`);
}

// 5. 落盘：result.json（断言/步骤全量）+ 各关键帧 PNG（失败也落盘供分析）。
const frameFiles: string[] = [];
for (const group of result.groups as any[]) {
  for (const round of group.rounds as any[]) {
    for (const [name, dataUrl] of Object.entries(round.frames ?? {}) as [string, string][]) {
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) continue;
      writeFileSync(join(output, name), Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"));
      frameFiles.push(name);
    }
  }
}
const summary = {
  ok: result.ok,
  adapter: result.adapter, canvasFormat: result.canvasFormat,
  observations: result.observations,
  groups: result.groups,
  frames: frameFiles,
  totals: {
    rounds: (result.groups as any[]).reduce((sum, group) => sum + group.rounds.length, 0),
    checksPassed: (result.groups as any[]).flatMap(group => group.rounds)
      .reduce((sum, round) => sum + round.checks.filter((check: any) => check.pass).length, 0),
    checksFailed: (result.groups as any[]).flatMap(group => group.rounds)
      .reduce((sum, round) => sum + round.checks.filter((check: any) => !check.pass).length, 0),
  },
};
writeFileSync(join(output, "result.json"), JSON.stringify(summary, null, 2) + "\n");
for (const group of result.groups as any[]) {
  for (const round of group.rounds as any[]) {
    const ms = round.steps.reduce((sum: number, step: any) => sum + step.ms, 0);
    console.log(`${group.id} / ${round.steps.map((step: any) => step.name).join(" -> ")} :: ${round.ok ? "PASS" : "FAIL"} (${ms}ms)`);
    for (const check of round.checks as any[]) {
      if (!check.pass) console.log(`  FAIL ${check.name}: expected=${JSON.stringify(check.expected)} actual=${JSON.stringify(check.actual)}`);
    }
  }
}
console.log(`P05 web matrix: ${summary.ok ? "committed" : "FAILED"}, adapter=${result.adapter ? result.adapter.vendor : "?"}`);
console.log(`checks passed=${summary.totals.checksPassed} failed=${summary.totals.checksFailed}; frames=${frameFiles.join(", ")}`);
console.log(`output: ${output}`);
if (!summary.ok) fail(`矩阵断言未全过：passed=${summary.totals.checksPassed} failed=${summary.totals.checksFailed}（明细见上方 FAIL 行与 result.json）`);
