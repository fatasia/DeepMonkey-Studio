import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";
import { createStaticServer } from "../apps/web/scripts/productBrowserSupport.mjs";

const [output, focused] = process.argv.slice(2);
assert(output, "Pass a new evidence directory");
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
const cases = [], icon = await readFile(path.join(root, "apps/web/public/brand/app-icon-chroma.png"));
try {
  for (const round of [1, 2]) for (const width of focused === "--branding-rejection" ? [480] : [1920, 980, 480]) for (const theme of ["dark", "light"]) {
    const id = `r${round}-${width}-${theme}`, errors = [], requests = [];
    const context = await browser.newContext({ viewport: { width, height: 900 } }), page = await context.newPage();
    let rejectBranding = focused === "--branding-rejection", preparations = 0;
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/public/applications/visual-qa", route => route.fulfill({ json: {
      id: "published-fixture", projectId: "visual-qa", applicationId: "visual-qa", applicationRevision: 7,
      publishedAt: "2026-09-18T01:00:00Z", document: { pages: [{ id: "page:overview" }], publicationProfiles: [] },
    } }));
    await page.route("**/dashboard-candidates", route => { preparations++; return route.fulfill({ status: 201, json: {
      candidateId: "branding-fixture", applicationRevision: 7, expiresAt: "2026-09-18T13:00:00Z",
      downloadFormats: ["exe", "zip", "web", "dmda"], objects: [],
    } }); });
    await page.route("**/dashboard-candidates/branding-fixture/*", route => {
      const request = route.request(), custom = request.method() === "POST";
      requests.push({ url: request.url(), method: request.method(), body: custom ? request.postDataJSON() : undefined });
      if (custom && rejectBranding) return route.fulfill({ status: 400,
        json: { code: "invalid_client_branding", message: "图标像素损坏，请换图后重新下载" } });
      return route.fulfill({ headers: { "content-type": "application/octet-stream",
        "content-disposition": custom ? "attachment; filename=\"client.exe\"; filename*=UTF-8''%E7%83%AD%E7%94%B5%E5%9B%AD%E5%8C%BA.exe" : 'attachment; filename="default.exe"' }, body: "ui-download-fixture" });
    });
    try {
      await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`);
      await page.getByRole("button", { name: "离线包", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "离线运行包" });
      await dialog.getByRole("button", { name: "开始准备", exact: true }).click();
      const name = dialog.getByRole("textbox", { name: "客户端名称", exact: true }); await name.waitFor();
      assert.equal(await name.getAttribute("placeholder"), "DeepMonkey Studio");
      const download = async label => {
        const event = page.waitForEvent("download");
        await dialog.getByRole("button", { name: label, exact: true }).click();
        const result = await event;
        await dialog.getByRole("status").filter({ hasText: "已开始下载" }).waitFor();
        return result;
      };
      await download("下载单文件 EXE"); assert.equal(requests.at(-1).method, "GET");
      await name.fill("热电园区");
      await dialog.locator("input[type=file]").setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: Buffer.from("bad bytes") });
      await dialog.getByRole("alert").filter({ hasText: "PNG 或 ICO" }).waitFor();
      await dialog.locator("input[type=file]").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: icon });
      await page.waitForFunction(() => document.querySelector(".dashboard-client-icon")?.getAttribute("src")?.startsWith("data:image/png"));
      assert.equal(await dialog.getByRole("alert").count(), 0);
      await name.focus(); await page.keyboard.press("Shift+Tab");
      assert(await dialog.getByRole("button", { name: "关闭离线包" }).evaluate(node => node === document.activeElement));
      await page.keyboard.press("Tab"); assert(await name.evaluate(node => node === document.activeElement));
      await dialog.locator(".dashboard-client-branding").screenshot({ path: path.join(evidence, `${id}-fields.png`) });
      await page.screenshot({ path: path.join(evidence, `${id}.png`) });
      if (rejectBranding) {
        await dialog.getByRole("button", { name: "下载单文件 EXE", exact: true }).click();
        await dialog.getByRole("alert").filter({ hasText: "图标像素损坏" }).waitFor();
        assert.equal(await name.inputValue(), "热电园区");
        assert(await name.isEnabled()); assert.equal(preparations, 1);
        await page.screenshot({ path: path.join(evidence, `${id}-server-rejection.png`) });
        rejectBranding = false;
      }
      assert.equal((await download("下载单文件 EXE")).suggestedFilename(), "热电园区.exe");
      assert.equal(requests.at(-1).method, "POST");
      assert.equal(requests.at(-1).body.branding.applicationName, "热电园区");
      assert(requests.at(-1).body.branding.iconDataUrl.startsWith("data:image/png;base64,"));
      await download("ZIP"); assert.equal(requests.at(-1).method, "POST");
      await download("Web 静态包"); assert.equal(requests.at(-1).method, "GET");
      await download("DMDA"); assert.equal(requests.at(-1).method, "GET");
      await dialog.getByRole("button", { name: "恢复默认", exact: true }).click();
      assert.equal(await name.inputValue(), "");
      assert.equal(await dialog.locator(".dashboard-client-icon").getAttribute("src"), "/brand/app-icon-industrial.svg");
      await download("下载单文件 EXE"); assert.equal(requests.at(-1).method, "GET");
      const geometry = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left,
        right: node.getBoundingClientRect().right, viewport: innerWidth,
        overflow: node.querySelector(".dashboard-client-branding").scrollWidth > node.querySelector(".dashboard-client-branding").clientWidth }));
      assert(geometry.left >= 0 && geometry.right <= geometry.viewport && !geometry.overflow);
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
      assert.deepEqual(errors, []); cases.push({ id, passed: true, requests: requests.map(({url,method}) => ({url,method})) });
    } catch (error) {
      cases.push({ id, passed: false, error: String(error), errors });
      await page.screenshot({ path: path.join(evidence, `${id}-failed.png`) }).catch(() => {});
    } finally { await context.close(); }
    console.log(`${cases.at(-1).passed ? "PASS" : "FAIL"} ${id}`);
  }
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ scope: "Real UI/browser downloads with intercepted candidate API; backend/PE acceptance is separate", cases }, null, 2));
}
assert(cases.every(row => row.passed), "Branding browser checks failed");
