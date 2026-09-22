import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";

const frontend = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(frontend, "delivery/scene-viewer.json"), "utf8"));
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = path.resolve(frontend, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!file.startsWith(`${frontend}${path.sep}`)) throw new Error("path");
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };
    response.setHeader("Content-Type", types[path.extname(file)] ?? "application/octet-stream");
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await playwright.chromium.launch({ headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const cases = [];
try {
  for (const round of [1, 2]) for (const width of [1920, 980]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(() => { window.__TAURI_INTERNALS__ = {}; });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => document.title === "客户园区验证");
    await page.waitForSelector("canvas");
    await page.waitForTimeout(1500);
    assert.equal(await page.getByText("桌面工作台", { exact: true }).count(), 0);
    const iconUrl = await page.locator('link[rel="icon"]').getAttribute("href");
    assert.equal(iconUrl, manifest.branding.iconUrl);
    assert.equal((await page.request.get(new URL(iconUrl, page.url()).href)).status(), 200);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, `r${round}-${width}.png`) });
    cases.push({ round, width, title: await page.title(), iconUrl, errors });
    await page.close();
  }
  await writeFile(path.join(output, "browser-evidence.json"), JSON.stringify(cases, null, 2));
  console.log(JSON.stringify({ passed: cases.length, output }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
