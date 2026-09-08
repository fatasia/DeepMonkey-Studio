import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { themeContext } from "./gateModelInstancesSupport.mjs";

// 只生成真实审核证据；任何一项的加载成功都不构成批准。
const root = resolve(import.meta.dirname, "../../.."), cache = resolve(root, "data/external-assets/source-b");
const catalog = JSON.parse(await readFile(resolve(cache, "catalog.json"), "utf8"));
const audit = JSON.parse(await readFile(resolve(cache, "audit.json"), "utf8"));
const approved = new Set(audit.items.filter(item => item.status === "approved").map(item => item.uid));
const requested = process.argv.find(argument => argument.startsWith("--uids="))?.slice(7).split(",");
const limit = Number(process.argv.find(argument => argument.startsWith("--limit="))?.slice(8) ?? 12);
assert.ok(Number.isInteger(limit) && limit > 0 && limit <= 40);
const targets = requested ? requested.map(uid => catalog.models.find(model => model.uid === uid)) : catalog.models.filter(model => !approved.has(model.uid)).slice(0, limit);
assert.ok(targets.length > 0 && targets.length <= 40 && targets.every(model => model && /^[a-f0-9]{32}$/.test(model.uid)));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const gate = await createIsolatedStudioGate("source-b-review");
const report = { createdAt: new Date().toISOString(), boundary: "仅离线缓存原模型浏览器证据；不自动批准、不改GLB、不下载模型", targets: targets.map(model => ({ uid: model.uid, name: model.name, author: model.author, license: model.license, licenseUrl: model.licenseUrl, originUrl: model.originUrl, hash: model.sha256, structure: model.modelAudit })), cases: [] };
console.log(JSON.stringify({ output: gate.output, targets: targets.map(model => model.uid) }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(30000); await gate.loginPage(page);
    for (const model of targets) {
      const entry = { round, theme, width, uid: model.uid, modelHash: model.sha256, errors: [], driverWarnings: [], expectedNetworkErrors: [], views: [], passed: false };
      report.cases.push(entry);
      const onError = error => entry.errors.push(error.message);
      const onConsole = message => {
        if (!["warning", "error"].includes(message.type())) return;
        const text = message.text();
        if (/^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
        else entry.errors.push(text);
      };
      page.on("pageerror", onError); page.on("console", onConsole);
      try {
        const file = resolve(cache, "models", `${model.uid}.glb`);
        assert.equal(hash(await readFile(file)), model.sha256);
        await page.goto(`${gate.origin}/optimizer`);
        await page.locator('.optimizer-page input[type="file"]').setInputFiles(file);
        const canvas = page.locator(".optimizer-canvas canvas"); await canvas.waitFor();
        await page.locator(".optimizer-preview-state").waitFor({ state: "detached" });
        await page.getByRole("button", { name: "适应窗口", exact: true }).click();
        const reflections = page.locator(".optimizer-render-settings label").filter({ hasText: "环境反射" }).getByRole("button");
        if (await reflections.innerText() === "关闭") await reflections.click();
        for (const angle of ["isometric", "rear", "upper"]) {
          const bounds = await canvas.boundingBox(); assert.ok(bounds);
          if (angle !== "isometric") {
            const x = bounds.x + bounds.width * .65, y = bounds.y + bounds.height * .6;
            await page.mouse.move(x, y); await page.mouse.down();
            await page.mouse.move(x - (angle === "rear" ? bounds.height * .42 : 0), y + (angle === "upper" ? bounds.height * .1 : 0), { steps: 18 });
            await page.mouse.up();
          }
          await page.waitForTimeout(650);
          const name = `r${round}-${theme}-${model.uid}-${angle}.png`, path = resolve(gate.output, name);
          const downloading = page.waitForEvent("download");
          await page.getByRole("button", { name: "下载预览图", exact: true }).click();
          await (await downloading).saveAs(path);
          const bytes = await readFile(path), metadata = await sharp(bytes).metadata();
          entry.views.push({ angle, path: name, sha256: hash(bytes), width: metadata.width, height: metadata.height });
        }
        await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${model.uid}-page.png`) });
        assert.equal(hash(await readFile(file)), model.sha256);
        assert.equal(entry.errors.length, 0, entry.errors.join("\n"));
        entry.passed = true;
      } catch (error) { entry.failure = error.stack ?? String(error); await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${model.uid}-failed.png`) }).catch(() => {}); }
      finally {
        page.off("pageerror", onError); page.off("console", onConsole);
        await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ round, theme, uid: model.uid, passed: entry.passed, errors: entry.errors.length, driverWarnings: entry.driverWarnings.length }));
      }
    }
    await context.close();
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, cases: report.cases.length, passed: report.cases.filter(entry => entry.passed).length }));
assert.ok(report.cases.length === targets.length * 4 && report.cases.every(entry => entry.passed), "Every requested model must pass both rounds and themes; inspect report.json for retained failures");
