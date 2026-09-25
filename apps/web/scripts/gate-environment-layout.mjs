import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { collectTextContrast } from "./browserTextContrast.mjs";

const output = fileURLToPath(new URL("../../../test-output/runs/2026-09-05/environment-layout/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = { createdAt: new Date().toISOString(), boundary: "Read-only QA scene, actual editor; no save or render-quality changes", cases: [] };
try {
  for (const width of [1440, 980]) for (const theme of ["dark", "light"]) {
    const entry = { width, theme, errors: [], warnings: [], writes: [] };
    report.cases.push(entry);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/**", async route => {
      const request = route.request();
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !request.url().endsWith("/api/auth/login")) {
        entry.writes.push(`${request.method()} ${request.url()}`);
        await route.fulfill({ status: 409, json: { message: "Unexpected write blocked" } });
      } else await route.fallback();
    });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", e => entry.errors.push(e.message));
    page.on("console", m => {
      if (m.type() === "error") entry.errors.push(m.text());
      else if (m.type() === "warning") entry.warnings.push(m.text());
    });
    try {
      await page.goto("http://127.0.0.1:5173/manager");
      await page.getByLabel("用户名", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill("admin");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByLabel("当前项目").selectOption({ label: "QA 回归检查 20260905" });
      // 直接打开专用 QA 三维路由；2D→3D 会先保存工作区，不属于本项只读布局验收。
      await page.goto("http://127.0.0.1:5173/studio/dfc62dfa-22f7-40ce-8cbe-aab2271cdc56/applications/abe8f38f-bdc3-47c7-89e3-a18c93069a9b/scenes/abe8f38f-bdc3-47c7-89e3-a18c93069a9b");
      await page.getByLabel("自动保存", { exact: true }).uncheck();
      await page.locator(".viewport canvas").waitFor();
      await page.getByRole("button", { name: "查看与分析", exact: true }).click();
      await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
      const panel = page.getByLabel("环境与全局灯光", { exact: true });
      await panel.waitFor();
      await panel.locator(".light-editor").scrollIntoViewIfNeeded();
      entry.layout = await panel.evaluate(root => {
        const post = root.querySelector(".post-processing-control");
        const grid = post.querySelector(".post-effect-grid").getBoundingClientRect();
        const panel = root.getBoundingClientRect();
        return { columns: getComputedStyle(post).gridTemplateColumns.split(" ").length,
          inside: panel.left >= 0 && panel.right <= innerWidth, headingHeight: root.querySelector(".environment-heading").getBoundingClientRect().height,
          gridWidth: grid.width, panelWidth: panel.width,
          names: [...root.querySelectorAll(".light-editor > label > span")].map(n => ({ text: n.textContent, height: n.getBoundingClientRect().height, line: parseFloat(getComputedStyle(n).lineHeight) })),
          buttons: [...post.querySelectorAll(".post-effect-grid button")].map(n => ({ text: n.textContent, width: n.clientWidth, scroll: n.scrollWidth })) };
      });
      await page.screenshot({ path: `${output}${theme}-${width}.png` });
      await panel.locator(".post-effect-grid").scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}${theme}-${width}-effects.png` });
      assert.equal(entry.layout.columns, 1, JSON.stringify(entry.layout));
      assert.ok(entry.layout.inside && entry.layout.headingHeight >= 40 && entry.layout.gridWidth > entry.layout.panelWidth * .8);
      assert.ok(entry.layout.names.every(n => n.height <= n.line + 1));
      assert.ok(entry.layout.buttons.every(b => b.width >= b.scroll && b.width >= 44));
      entry.contrast = await panel.evaluate(collectTextContrast, ".environment-heading strong, .environment-heading small, .light-system-head > span, .light-editor > label > span");
      assert.ok(entry.contrast.every(item => item.contrast >= 4.5));
      assert.deepEqual(entry.errors, []);
      assert.deepEqual(entry.writes, []);
      assert.ok(entry.warnings.every(w => w.includes("powerPreference") || w.includes("X4122")), JSON.stringify(entry.warnings));
      entry.passed = true;
    } catch (e) { entry.failure = String(e); await page.screenshot({ path: `${output}${theme}-${width}-failed.png` }); }
    finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(`${output}report.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
assert.ok(report.cases.every(c => c.passed), `Inspect ${output}`);
