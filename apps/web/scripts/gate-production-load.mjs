import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { createProductServer } from "./onlineFlowProductServer.mjs";

// 复用既有生产静态服务器；独占测试端口，不替换 5173 开发实例。
const output = fileURLToPath(new URL("../../../test-output/runs/2026-09-05/production-load/", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const server = createProductServer(dist, "http://127.0.0.1:4100");
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(4174, "127.0.0.1", resolve); });
await mkdir(output, { recursive: true });
const origin = "http://127.0.0.1:4174";
const report = { createdAt: new Date().toISOString(), conditions: "Production bundle, local API/assets, authenticated resource-cache disabled, no CPU/network throttle; not a large-model benchmark", cases: [] };
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  for (const theme of ["dark", "light"]) {
    const entry = { theme, errors: [], platformWarnings: [], injectedErrors: [], writes: [], loads: [] };
    report.cases.push(entry);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route("**/api/**", async route => {
      const request = route.request();
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && new URL(request.url()).pathname !== "/api/auth/login") {
        entry.writes.push(`${request.method()} ${request.url()}`);
        await route.fulfill({ status: 409, json: { message: "QA blocked unexpected write" } });
      } else await route.fallback();
    });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on("pageerror", error => entry.errors.push(error.message));
    let injectFailure = false;
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      const text = message.text();
      if (injectFailure && /status of 503/.test(text)) entry.injectedErrors.push(text);
      else if (message.type() === "warning" && (text.startsWith("The powerPreference option is currently ignored when calling requestAdapter() on Windows.") || (text.startsWith("THREE.WebGLProgram: Program Info Log:") && text.includes("warning X4122") && !/error|failed/i.test(text)))) entry.platformWarnings.push(text);
      else entry.errors.push(text);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    try {
      let releaseScripts;
      const scriptsHeld = new Promise(resolve => { releaseScripts = resolve; });
      const scriptRoute = async route => { await scriptsHeld; await route.fallback(); };
      await context.route(/\/assets\/.*\.js(?:\?|$)/, scriptRoute);
      await page.goto(`${origin}/manager`, { waitUntil: "commit" });
      try {
        await page.getByRole("status").filter({ hasText: "正在加载工作台" }).waitFor();
        await page.screenshot({ path: `${output}${theme}-before-javascript.png` });
        entry.htmlLoadingBeforeJavaScript = true;
      } finally { releaseScripts(); }
      await context.unroute(/\/assets\/.*\.js(?:\?|$)/, scriptRoute);
      await page.getByRole("textbox", { name: "用户名", exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill("admin");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByLabel("当前项目").selectOption({ label: "智造综合案例验证" });
      const card = page.locator(".scene-card").filter({ has: page.getByRole("button", { name: "1", exact: true }) }).first();
      await card.getByRole("button", { name: "更多场景操作", exact: true }).click();
      const publishedPagePromise = context.waitForEvent("page");
      await card.getByRole("button", { name: "查看发布版", exact: true }).click();
      const publishedPage = await publishedPagePromise;
      await publishedPage.waitForURL(/\/published\//, { waitUntil: "commit" });
      const publishedUrl = publishedPage.url();
      await publishedPage.close();
      for (const [kind, url] of [["preview", `${origin}/view/abe8f38f-bdc3-47c7-89e3-a18c93069a9b`], ["published", publishedUrl]]) {
        const sceneId = new URL(url).pathname.split("/").at(-1);
        const browsePath = `${origin}/api/${kind === "published" ? "public/" : ""}scenes/${sceneId}/browse`;
        const browseResponse = page.waitForResponse(response => response.url() === browsePath && response.status() === 200);
        await page.goto(url, { waitUntil: "commit" });
        await page.locator(".viewport canvas").waitFor();
        await page.locator(".renderer-loading").waitFor({ state: "hidden" });
        await page.locator(".published-load-state.ready").waitFor();
        const metrics = await page.evaluate(() => ({
          readyMs: Math.round(performance.now()),
          paints: performance.getEntriesByType("paint").map(item => ({ name: item.name, ms: Math.round(item.startTime) })),
          resources: performance.getEntriesByType("resource").length,
          canvas: Array.from(document.querySelectorAll(".viewport canvas")).map(node => ({ width: node.width, height: node.height })),
        }));
        assert.ok(metrics.canvas.some(size => size.width > 0 && size.height > 0));
        const data = await (await browseResponse).json();
        const snapshot = kind === "published" ? data.publication.snapshot : data.scene;
        entry.loads.push({ kind, url, ...metrics, sample: { models: snapshot.models.length, primitives: snapshot.primitives.length, publicationMode: snapshot.publicationMode } });
        await page.locator(".published-load-state").waitFor({ state: "hidden" });
        await page.screenshot({ path: `${output}${theme}-${kind}-loaded.png` });
        let releaseScene;
        const heldScene = new Promise(resolve => { releaseScene = resolve; });
        const sceneRoute = async route => { await heldScene; await route.fallback(); };
        await context.route(browsePath, sceneRoute);
        await page.reload({ waitUntil: "commit" });
        try {
          await page.getByText("正在读取场景", { exact: true }).waitFor();
          assert.equal(await page.getByRole("progressbar", { name: "场景加载进度" }).getAttribute("value"), null);
          await page.screenshot({ path: `${output}${theme}-${kind}-waiting-data.png` });
        } finally { releaseScene(); }
        await context.unroute(browsePath, sceneRoute);
        await page.locator(".published-load-state.ready").waitFor();
        const failedRoute = route => route.fulfill({ status: 503, json: { message: "QA 场景服务暂时不可用" } });
        await context.route(browsePath, failedRoute);
        injectFailure = true;
        await page.reload({ waitUntil: "commit" });
        await page.locator(".published-load-state.error").waitFor();
        await page.screenshot({ path: `${output}${theme}-${kind}-failure.png` });
        await context.unroute(browsePath, failedRoute);
        injectFailure = false;
        await page.getByRole("button", { name: "重新加载", exact: true }).click();
        await page.locator(".published-load-state.ready").waitFor();
        entry.loads.at(-1).waitingFailureRetryPassed = true;
      }
      assert.deepEqual(entry.errors, []);
      assert.deepEqual(entry.writes, []);
      entry.passed = true;
    } catch (error) {
      entry.failure = String(error);
      await page.screenshot({ path: `${output}${theme}-failed.png` });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
