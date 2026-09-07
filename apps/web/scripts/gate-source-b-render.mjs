import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";
import sharp from "sharp";

const requested = process.argv.find(argument => argument.startsWith("--uids="))?.slice(7);
const targets = requested ? requested.split(",") : ["71df42c5d5964d2ea149c5513bbc061b", "cda46c9b520c48708dbecb5a72bfdf9a"];
assert.ok(targets.length > 0 && targets.length <= 20 && targets.every(uid => /^[a-f0-9]{32}$/.test(uid)), "指定1至20个有效模型UID");
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
      const reflections = page.locator(".optimizer-render-settings label").filter({ hasText: "环境反射" }).getByRole("button");
      if (await reflections.innerText() === "关闭") await reflections.click();
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
      if (process.argv.includes("--assert-framed")) {
        const { data, info } = await sharp(await readFile(thumbnailPath)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const edges = { left: info.width, right: 0, top: info.height, bottom: 0 }; let foreground = 0;
        for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
          const offset = (y * info.width + x) * info.channels;
          if (Math.max(...[0, 1, 2].map(channel => Math.abs(data[offset + channel] - data[channel]))) <= 30) continue;
          foreground++; edges.left = Math.min(edges.left, x); edges.right = Math.max(edges.right, x); edges.top = Math.min(edges.top, y); edges.bottom = Math.max(edges.bottom, y);
        }
        const margin = Math.min(info.width, info.height) * 0.03;
        assert.ok(foreground > info.width * info.height * 0.01, "模型不能为空");
        assert.ok(edges.left >= margin && edges.top >= margin && edges.right < info.width - margin && edges.bottom < info.height - margin, "模型像素触及边框或缺少取景留白");
        entry.thumbnail.pixelBounds = edges;
      }
      assert.deepEqual(entry.errors, []);
      entry.passed = true;
    } catch (error) { entry.failure = error.stack; await page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${uid}-failed.png`) }); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, ...report }));
