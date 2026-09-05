import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const output = fileURLToPath(new URL("../../../test-output/codex-2026-09-05/node-red/", import.meta.url));
await mkdir(output, { recursive: true });
const report = { createdAt: new Date().toISOString(), cases: [] };
const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, errors: [], injectedErrors: [], writes: [] };
    report.cases.push(entry);
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    let healthMode = "live";
    await context.route("**/api/node-red/health", async route => {
      if (healthMode === "offline") await route.fulfill({ status: 200, json: { online: false } });
      else if (healthMode === "failed") await route.fulfill({ status: 503, json: { message: "QA injected health failure" } });
      else await route.fallback();
    });
    await context.route("**/api/**", async route => {
      if (!["GET", "HEAD", "OPTIONS"].includes(route.request().method()) && new URL(route.request().url()).pathname !== "/api/auth/login") {
        entry.writes.push(`${route.request().method()} ${route.request().url()}`);
        await route.fulfill({ status: 409, json: { message: "QA blocked unexpected write" } });
      } else await route.fallback();
    });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (["warning", "error"].includes(message.type())) {
        const text = message.text();
        if (healthMode === "failed" && text.includes("503")) entry.injectedErrors.push(text);
        else entry.errors.push(text);
      }
    });
    const shot = name => page.screenshot({ path: `${output}${theme}-${width}-${name}.png`, fullPage: true });
    try {
      await page.goto(`${origin}/manager`);
      await page.getByRole("textbox", { name: "用户名", exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill("admin");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByRole("button", { name: "数据中心", exact: true }).click();
      await page.getByRole("button", { name: "高级接入", exact: true }).click();
      const editor = page.frameLocator('iframe[title="Node-RED 高级事件编排"]');
      await editor.locator("#red-ui-workspace-chart").waitFor();
      await editor.locator("#red-ui-palette-search input").pressSequentially("http request");
      await editor.locator('[data-palette-type="inject"]').waitFor({ state: "hidden" });
      await editor.locator('[data-palette-type="http request"]').waitFor();
      assert.equal(await page.locator(".node-red-studio").evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      await shot("editor-http-request");
      entry.editorReady = true;
      const popupPromise = context.waitForEvent("page");
      await page.getByRole("link", { name: "运行看板", exact: true }).click();
      const dashboard = await popupPromise;
      await dashboard.getByText("设备总览", { exact: true }).first().waitFor();
      await dashboard.screenshot({ path: `${output}${theme}-${width}-runtime-dashboard.png` });
      entry.dashboardReady = true;
      await dashboard.close();
      const cdp = await context.newCDPSession(page);
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      for (const setting of ["denied", "granted"]) {
        for (const allowWithoutSanitization of [true, false]) await cdp.send("Browser.setPermission", { permission: { name: "clipboard-write", allowWithoutSanitization }, setting, origin, browserContextId: targetInfo.browserContextId });
        await page.getByRole("button", { name: "复制 HTTP 地址", exact: true }).click();
        if (setting === "denied") await page.getByRole("alert").filter({ hasText: "复制失败" }).waitFor();
        else {
          await page.getByRole("button", { name: "复制 HTTP 地址", exact: true }).getByText("已复制", { exact: true }).waitFor();
          assert.equal(await page.getByRole("alert").count(), 0);
        }
      }
      entry.clipboardFailureAndRetry = true;
      for (const mode of ["offline", "failed"]) {
        healthMode = mode;
        await page.getByRole("button", { name: /接入数据/ }).click();
        await page.getByRole("button", { name: "高级接入", exact: true }).click();
        await page.getByText(mode === "offline" ? "Node-RED 服务未运行" : "暂时无法确认服务状态", { exact: true }).waitFor();
        assert.equal(await page.locator(".node-red-studio iframe").count(), 0);
        await shot(mode);
        healthMode = "live";
        await page.getByRole("button", { name: "重新检查", exact: true }).focus();
        await page.keyboard.press("Enter");
        await editor.locator("#red-ui-workspace-chart").waitFor();
      }
      entry.healthFailureAndRetry = true;
      assert.deepEqual(entry.errors, []);
      assert.deepEqual(entry.writes, []);
      entry.passed = true;
    } catch (error) {
      entry.failure = String(error);
      await shot("failed");
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
