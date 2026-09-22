import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";
import { createStaticServer } from "../apps/web/scripts/productBrowserSupport.mjs";

const [output, ...rest] = process.argv.slice(2);
assert(output && !rest.length, "Usage: node scripts/verify-dashboard-download-browser.mjs <new-evidence-directory>");
const root = fileURLToPath(new URL("../", import.meta.url)), evidence = path.resolve(output), dist = path.join(evidence, "dist");
await mkdir(evidence);
const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const { build } = await import(pathToFileURL(require.resolve("vite")).href);
await build({ root: path.join(root, "apps/web"), configFile: path.join(root, "apps/web/vite.config.ts"),
  define: { "import.meta.env.VITE_VISUAL_QA": '"true"' }, build: { outDir: dist, emptyOutDir: false }, logLevel: "error" });
const server = createStaticServer(dist); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true,
  executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const cases = [];
try {
  for (let round = 1; round <= 2; round++) for (const width of [1920, 980, 480]) for (const theme of ["dark", "light"]) {
    const id = `r${round}-${width}-${theme}`, errors = [], context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    let formats = ["exe", "zip", "web", "dmda"], failDownload = false;
    let releasePrepare;
    const prepareGate = new Promise(resolve => { releasePrepare = resolve; });
    await page.route("**/api/public/applications/visual-qa", route => route.fulfill({ json: {
      id: "published-fixture", projectId: "visual-qa", applicationId: "visual-qa", applicationRevision: 7,
      publishedAt: "2026-09-18T01:00:00Z", document: { pages: [{ id: "page:overview" }], publicationProfiles: [] },
    } }));
    await page.route("**/dashboard-candidates", async route => { await prepareGate; return route.fulfill({ status: 201, json: {
      candidateId: "candidate-fixture", applicationRevision: 7, expiresAt: "2026-09-18T02:00:00Z", downloadFormats: formats,
      objects: [{ nodeId: "widget:output", status: "supported", deferredFields: [] },
        { nodeId: "widget:long-identity-for-tooltip-and-overflow", status: "degraded", deferredFields: ["interaction"] }],
    } }); });
    await page.route("**/dashboard-candidates/candidate-fixture/web-package", route => failDownload
      ? route.fulfill({ status: 410, json: { code: "candidate_expired", message: "候选过期" } })
      : route.fulfill({ headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="dashboard.web.zip"' }, body: "browser-download-fixture" }));
    try {
      await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`);
      await page.getByRole("button", { name: "离线包", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "离线运行包" }); await dialog.waitFor();
      await page.emulateMedia({ reducedMotion: "reduce" });
      const feedbackMs = await dialog.getByRole("button", { name: "开始准备", exact: true }).evaluate(button => new Promise((resolve, reject) => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (!document.querySelector(".dashboard-offline-busy")) return;
          observer.disconnect(); clearTimeout(timer); resolve(performance.now() - start);
        });
        const timer = setTimeout(() => { observer.disconnect(); reject(new Error("No preparation feedback")); }, 1000);
        observer.observe(document.body, { subtree: true, childList: true }); button.click();
      }));
      assert(feedbackMs <= 100, `Preparation feedback exceeded 100ms: ${feedbackMs}`);
      assert.equal(await dialog.locator(".spin").evaluate(element => getComputedStyle(element).animationName), "none");
      releasePrepare();
      await dialog.getByRole("button", { name: "Web 静态包", exact: true }).waitFor();
      assert.equal(await dialog.getAttribute("aria-modal"), "true");
      const firstButton = dialog.getByRole("button").first(), lastButton = dialog.getByRole("button").last();
      await lastButton.focus(); await page.keyboard.press("Tab");
      assert(await firstButton.evaluate(element => element === document.activeElement), "Tab escaped the dialog");
      await firstButton.focus(); await page.keyboard.press("Shift+Tab");
      assert(await lastButton.evaluate(element => element === document.activeElement), "Reverse Tab escaped the dialog");
      await page.emulateMedia({ reducedMotion: "reduce" });
      const bounds = await dialog.evaluate(element => {
        const outer = element.getBoundingClientRect();
        return { width: innerWidth, outer: { left: outer.left, right: outer.right }, buttons: [...element.querySelectorAll("button")]
          .map(button => { const r = button.getBoundingClientRect(); return { left: r.left, right: r.right }; }) };
      });
      assert(bounds.outer.left >= 0 && bounds.outer.right <= bounds.width);
      for (const button of bounds.buttons) assert(button.left >= bounds.outer.left && button.right <= bounds.outer.right, "Clipped download action");
      await page.screenshot({ path: path.join(evidence, `${id}.png`) });
      const downloading = page.waitForEvent("download");
      await dialog.getByRole("button", { name: "Web 静态包", exact: true }).click();
      assert.equal((await downloading).suggestedFilename(), "dashboard.web.zip");
      await dialog.getByRole("status").filter({ hasText: "已开始下载" }).waitFor();
      failDownload = true; await dialog.getByRole("button", { name: "Web 静态包", exact: true }).click();
      await dialog.getByRole("alert").filter({ hasText: "已过期" }).waitFor();
      formats = ["dmda"]; await dialog.getByRole("button", { name: "重新准备", exact: true }).click();
      await dialog.getByRole("button", { name: "DMDA", exact: true }).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "Web 静态包", exact: true }).count(), 0);
      assert.equal(await dialog.getByRole("button", { name: "下载单文件 EXE", exact: true }).count(), 0);
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
      assert(await page.getByRole("button", { name: "离线包", exact: true })
        .evaluate(element => element === document.activeElement), "Dialog close did not restore focus");
      assert.deepEqual(errors, []); cases.push({ id, passed: true, feedbackMs });
    } catch (error) {
      cases.push({ id, passed: false, error: String(error), errors });
      await page.screenshot({ path: path.join(evidence, `${id}-failed.png`) }).catch(() => {});
    } finally { await context.close(); }
    console.log(`${cases.at(-1).passed ? "PASS" : "FAIL"} ${id}`);
  }
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ scope: "real component with intercepted API fixtures; not backend acceptance", cases }, null, 2));
}
assert(cases.every(item => item.passed), `${cases.filter(item => !item.passed).length} dialog checks failed`);
