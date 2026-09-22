// F6 仓外独立消费示例驱动：在仓库外的系统临时目录模拟第三方消费者，
// 完整走一遍"构建 dist → pnpm pack → npm init → 离线安装 .tgz → 运行两例"链路：
//   1. Node 示例（examples/node-standalone.mjs）：纯逻辑校验器 + 探针打包器断言；
//   2. Browser 示例（examples/browser-standalone.{mjs,html}）：esbuild bundle 后
//      由 headless Chrome（playwright-core）加载，断言模块可用与纯函数结果。
// 证据全部写入 test-output/f6-standalone-20260923/；不在仓内留下任何依赖改动。
// 复用既有 gate:deep-engine-consumer 的打包/进程 lib（packDeepEngineConsumerDependencies
// 负责 tarball 内容、私有性与 sha256 断言），本脚本只补 npm 离线安装与示例执行缺口。

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile, access } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packDeepEngineConsumerDependencies } from "../../../scripts/lib/deepEngineConsumerPackages.mjs";
import { isWithin, locatePnpm, runLogged } from "../../../scripts/lib/sdkConsumerPackages.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(root, "packages/deep-engine");
const examplesDir = join(packageRoot, "examples");
const reportDir = join(root, "test-output/f6-standalone-20260923");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
// 断网探针：指向必然拒绝连接的回环端口，任何注册表请求都会让离线安装失败。
const offlineRegistry = "http://127.0.0.1:9/";
// tar 语义修正：MSYS GNU tar 会把 `C:\...` 归档路径当远程主机（"Cannot connect to C:"）。
// 共享打包 lib 以裸 `tar` 列 tarball 内容，这里给本驱动的子进程 PATH 前置 Windows
// 系统 bsdtar（能正确处理盘符路径），不影响仓库其他进程。
if (process.platform === "win32") process.env.PATH = "C:\\Windows\\system32;" + process.env.PATH;
const report = { schema: 1, status: "running", startedAt: new Date().toISOString(), node: process.version, chromePath };
console.log(`[f6-standalone] evidence: ${reportDir}`);

// Windows 下 npm 不可直接 spawn（npm.cmd），统一用 node + npm-cli.js 驱动。
async function locateNpmCli() {
  const candidates = [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    "C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js"];
  for (const path of candidates) { try { await access(path); return path; } catch { /* 尝试下一个候选 */ } }
  throw new Error("未找到 npm-cli.js；本驱动不下载包管理器工具。");
}

// 第三方 package.json：依赖全部指向本地 .tgz（file: 协议），
// 用 overrides 把传递依赖 @webgpu/types 也钉在同一本地 tarball 上——
// 规格与直接依赖完全一致，满足 npm overrides 的同规格约束。
function consumerManifest(workspace, packed) {
  const specs = Object.fromEntries(packed.map(pkg => {
    const spec = `file:${relative(join(workspace, "consumer"), pkg.archive).replaceAll("\\", "/")}`;
    return [pkg.name, spec];
  }));
  return {
    name: "f6-deep-engine-standalone-consumer",
    private: true,
    type: "module",
    description: "F6 第三方独立消费示例：离线安装 @bim-studio/deep-engine 并运行 Node/Browser 两例",
    dependencies: specs,
    overrides: { "@webgpu/types": specs["@webgpu/types"] },
  };
}

async function verifyBrowserExample(workspace, consumer) {
  // 阶段目录：html + esbuild 产物同目录，由一次性本地 HTTP 服务托管。
  const stage = await mkdtemp(join(workspace, "browser-stage-"));
  await cp(join(examplesDir, "browser-standalone.html"), join(stage, "browser-standalone.html"));
  const esbuild = await import("esbuild");
  const bundleResult = await esbuild.build({
    absWorkingDir: consumer,
    entryPoints: ["examples/browser-standalone.mjs"],
    outfile: join(stage, "browser-standalone.bundle.mjs"),
    bundle: true, platform: "browser", format: "esm", target: "es2022",
    conditions: ["browser"], logLevel: "silent",
  });
  assert.deepEqual(bundleResult.warnings, [], "浏览器 bundle 不得出现警告");
  const html = await readFile(join(stage, "browser-standalone.html"));
  const bundle = await readFile(join(stage, "browser-standalone.bundle.mjs"));
  const server = createServer((request, response) => {
    if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html); }
    else if (request.url === "/browser-standalone.bundle.mjs") { response.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle); }
    else if (request.url === "/favicon.ico") { response.writeHead(204).end(); }
    else { response.writeHead(404).end(); }
  });
  await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  // playwright-core 与系统 Chrome 的启动模式参照 scripts/gpuParticleRenderTest.mjs。
  const { default: playwright } =
    await import(pathToFileURL(join(root, "apps/cloud-render-worker/node_modules/playwright-core/index.js")).href);
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage();
    const consoleIssues = [];
    page.on("console", message => { if (["error", "warning"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`); });
    page.on("pageerror", error => consoleIssues.push(`pageerror: ${error.message}`));
    await page.goto(`${origin}/`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(globalThis.__F6_STANDALONE_RESULT__), null, { timeout: 30_000 });
    const domResult = await page.evaluate(() => ({
      window: globalThis.__F6_STANDALONE_RESULT__,
      domText: document.getElementById("standalone-output")?.textContent ?? "",
    }));
    // 模块导出的纯函数再调一次，与页面自运行结果必须一致。
    const moduleResult = await page.evaluate(async () =>
      (await import("./browser-standalone.bundle.mjs")).runBrowserProbe());
    assert.deepEqual(moduleResult, domResult.window, "模块调用与页面自运行结果必须一致");
    assert.equal(domResult.domText, JSON.stringify(domResult.window), "DOM 输出必须是结果 JSON");
    const summary = domResult.window;
    assert.equal(summary.runtime.valid, true, "合法运行时必须通过校验");
    assert.equal(summary.runtime.rejectedValid, false, "非法运行时必须被拒绝");
    assert.equal(summary.runtime.issuePath, "$.schema");
    assert.equal(summary.probeGrid.bytes, 864, "探针网格必须是 (1+8)*96 字节");
    assert.equal(summary.probeGrid.headerCount, 8);
    assert.equal(summary.probeGrid.headerSpacing, 2);
    assert.deepEqual(consoleIssues, [], "浏览器示例不得产生 console error/warning 或页面异常");
    await page.screenshot({ path: join(reportDir, "browser-standalone.png"), fullPage: true });
    const evidence = { origin, browserVersion: browser.version(), module: summary.module,
      runtime: summary.runtime, probeGrid: summary.probeGrid, consoleIssues };
    await writeFile(join(reportDir, "browser-result.json"), JSON.stringify(evidence, null, 2) + "\n");
    console.log("[f6-standalone] browser example: passed");
    return evidence;
  } finally {
    await browser.close();
    server.close();
  }
}

async function main() {
  await mkdir(reportDir, { recursive: true });
  const pnpm = await locatePnpm();
  const npmCli = await locateNpmCli();
  report.pnpm = (await runLogged(process.execPath, [pnpm, "--version"], { cwd: root, reportDir, label: "pnpm-version" })).trim();
  report.npm = (await runLogged(process.execPath, [npmCli, "--version"], { cwd: root, reportDir, label: "npm-version" })).trim();

  // 步骤 1：重建 dist，保证 tarball 内容与当前源码一致（pack 前置条件）。
  await runLogged(process.execPath, [pnpm, "-C", packageRoot, "run", "build"],
    { cwd: packageRoot, reportDir, label: "build-dist", timeout: 600_000 });

  // 步骤 2：pnpm pack 引擎与 @webgpu/types（lib 内含 tarball 私有性/导出/sha256 断言）。
  const workspace = await mkdtemp(join(tmpdir(), "f6-standalone-"));
  assert.ok(!isWithin(root, workspace), "消费者工作区必须在仓库之外");
  report.workspace = workspace;
  report.packed = await packDeepEngineConsumerDependencies({ root, workspace, reportDir, pnpm });

  // 步骤 3：npm init + file: 依赖 + overrides + 离线安装（断网注册表探针）。
  const consumer = join(workspace, "consumer");
  await mkdir(consumer);
  await runLogged(process.execPath, [npmCli, "init", "--yes"], { cwd: consumer, reportDir, label: "npm-init" });
  const manifest = consumerManifest(workspace, report.packed);
  await writeFile(join(consumer, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  await runLogged(process.execPath, [npmCli, "install", "--offline", "--ignore-scripts", "--no-fund", "--no-audit",
    "--cache", join(workspace, "npm-cache")],
    { cwd: consumer, reportDir, label: "npm-install-offline", timeout: 300_000,
      env: { npm_config_registry: offlineRegistry } });
  report.npmInstall = { offline: true, registry: offlineRegistry, overrides: manifest.overrides };

  // 步骤 4：安装产物必须落在仓外 node_modules，且携带可运行的 dist 导出。
  const installedEngine = await realpath(join(consumer, "node_modules/@bim-studio/deep-engine"));
  assert.ok(isWithin(workspace, installedEngine) && !isWithin(root, installedEngine), "安装必须发生在仓库之外");
  for (const path of ["dist/index.js", "dist/runtimePackage/index.js", "dist/lighting/index.js"]) {
    await access(join(installedEngine, path));
  }
  report.installedEnginePath = installedEngine;

  // 步骤 5：拷贝示例源码并真实运行 Node 示例（输出即证据 run-node-example.log）。
  await mkdir(join(consumer, "examples"), { recursive: true });
  for (const name of ["node-standalone.mjs", "browser-standalone.mjs", "browser-standalone.html"]) {
    await cp(join(examplesDir, name), join(consumer, "examples", name));
  }
  const nodeOutput = await runLogged(process.execPath, ["examples/node-standalone.mjs"],
    { cwd: consumer, reportDir, label: "run-node-example" });
  assert.ok(nodeOutput.includes("F6-NODE-STANDALONE:ALL-OK"), "Node 示例必须以 ALL-OK 结束");
  report.nodeExample = { command: "node examples/node-standalone.mjs", marker: "F6-NODE-STANDALONE:ALL-OK" };

  // 步骤 6：esbuild bundle + headless Chrome 加载浏览器示例并断言。
  report.browser = await verifyBrowserExample(workspace, consumer);
  report.status = "passed";
}

try {
  await main();
  console.log("[f6-standalone] PASSED; 未发布任何包，仓内依赖未改动");
} catch (error) {
  report.status = "failed";
  report.error = error.stack ?? String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n").catch(() => {});
}
