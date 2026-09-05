import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const targets = ["71df42c5d5964d2ea149c5513bbc061b", "cda46c9b520c48708dbecb5a72bfdf9a"];
const root = resolve(import.meta.dirname, "../../..");
const cache = resolve(root, "data/external-assets/source-b");
const catalog = JSON.parse(await readFile(resolve(cache, "catalog.json"), "utf8"));
const gate = await createIsolatedStudioGate("source-b-render");
const report = { createdAt: new Date().toISOString(), boundary: "原始模型真实渲染；截图仍需人工复核，不自动发布", cases: [] };
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) for (const uid of targets) {
    const model = catalog.models.find(item => item.uid === uid);
    assert.ok(model?.modelAudit?.valid, `Missing validated model ${uid}`);
    const file = resolve(cache, "models", `${uid}.glb`);
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), model.sha256);
    const entry = { theme, width, uid, name: model.name, modelHash: model.sha256, errors: [], driverWarnings: [], passed: false };
    report.cases.push(entry);
    const context = await gate.browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      if (/^THREE\.WebGLProgram: Program Info Log:/.test(message.text()) && /warning X4122: sum of/.test(message.text()) && !/error/i.test(message.text())) entry.driverWarnings.push(message.text());
      else entry.errors.push(message.text());
    });
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/optimizer`);
      await page.locator('.optimizer-page input[type="file"]').setInputFiles(file);
      const canvas = page.locator(".optimizer-canvas canvas");
      await canvas.waitFor();
      await page.locator(".optimizer-preview-state").waitFor({ state: "detached" });
      await page.getByRole("button", { name: "适应窗口", exact: true }).click();
      await page.locator(".optimizer-render-settings label").filter({ hasText: "环境反射" }).getByRole("button").click();
      await page.waitForTimeout(500);
      const thumbnailPath = resolve(gate.output, `${theme}-${width}-${uid}.png`);
      const download = page.waitForEvent("download");
      await page.getByRole("button", { name: "下载预览图", exact: true }).click();
      await (await download).saveAs(thumbnailPath);
      await page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${uid}-page.png`) });
      entry.contrast = await page.locator(".optimizer-preview-actions").evaluate(collectTextContrast, "button");
      assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      entry.thumbnail = { path: thumbnailPath, sha256: createHash("sha256").update(await readFile(thumbnailPath)).digest("hex"), ...await canvas.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight })) };
      assert.deepEqual(entry.errors, []);
      entry.passed = true;
    } catch (error) { entry.failure = error.stack; await page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${uid}-failed.png`) }); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, ...report }));
