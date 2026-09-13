import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const output = resolve("test-output/visual-compare/layer-refinement"); await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = [];
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const entry = { round, theme, width, errors: [], passed: false }; report.push(entry);
    page.on("pageerror", error => entry.errors.push(error.message));
    try {
      await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "networkidle" });
      const nodes = page.locator(".dashboard-layer-select"); const before = await nodes.count();
      await nodes.nth(0).click(); await nodes.nth(1).click({ modifiers: ["Control"] });
      await nodes.nth(1).click({ button: "right" });
      await page.locator(".dashboard-context-menu").getByRole("button", { name: /^编组/ }).click();
      await page.locator(".dashboard-layer-group").waitFor();
      await page.locator(".dashboard-group-row").click({ button: "right" });
      await page.locator(".dashboard-context-menu").getByRole("button", { name: "取消编组", exact: true }).click();
      assert.equal(await page.locator(".dashboard-layer-group").count(), 0);
      await nodes.nth(0).click(); await nodes.nth(1).click({ modifiers: ["Control"] }); await page.keyboard.press("Control+g");
      const member = page.locator(".dashboard-layer-children .dashboard-layer-row").first();
      await member.locator(".dashboard-layer-select").click(); await member.dragTo(page.locator(".scene-layer-root-drop"));
      assert.equal(await page.locator(".dashboard-layer-children .dashboard-layer-row").count(), 1);
      assert.equal(await nodes.count(), before);
      await page.screenshot({ path: resolve(output, `r${round}-${theme}-${width}-layers.png`) });
      for (const nextWidth of [1440, 980, 1200]) {
        await page.setViewportSize({ width: nextWidth, height: 1000 });
        const control = page.locator(".dashboard-panel-controls .panel-toggle-right");
        for (const collapsed of [true, false]) {
          if ((await control.getAttribute("aria-pressed") === "false") !== collapsed) await control.click();
          const metrics = await control.evaluate(button => { const rect = button.getBoundingClientRect(), canvas = document.querySelector(".dashboard-canvas-area, .dashboard-canvas-shell")?.getBoundingClientRect(), panel = document.querySelector(".dashboard-inspector-panel").getBoundingClientRect(); return { center: (rect.left + rect.right) / 2, left: rect.left, right: rect.right, panelLeft: panel.left, panelWidth: panel.width, screen: innerWidth, canvasRight: canvas?.right }; });
          assert.ok(metrics.left >= 0 && metrics.right <= metrics.screen, JSON.stringify(metrics));
          if (!collapsed) assert.ok(Math.abs(metrics.center - metrics.panelLeft) <= 1, JSON.stringify(metrics));
        }
      }
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await page.screenshot({ path: resolve(output, `r${round}-${theme}-${width}-failed.png`) }); throw error; }
    finally { await page.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2)); await browser.close(); }
