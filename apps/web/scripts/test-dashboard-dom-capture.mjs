import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const output = path.join(root, "test-output/dashboard-dom-capture");
const require = createRequire(realpathSync(fileURLToPath(new URL("../node_modules/vite/package.json", import.meta.url))));
const { build } = require("esbuild");
await mkdir(output, { recursive: true });
await build({ entryPoints: [fileURLToPath(new URL("./fixtures/dashboardDataCapture.tsx", import.meta.url))],
  bundle: true, format: "esm", platform: "browser", outfile: path.join(output, "capture.js"),
  conditions: ["development"], define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" },
  loader: { ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" } });
await writeFile(path.join(output, "index.html"), '<!doctype html><html><head><link rel="stylesheet" href="/capture.css"></head><body><div id="root"></div><script type="module" src="/capture.js"></script></body></html>');
const server = createServer(async (request, response) => {
  const name = request.url === "/" ? "index.html" : request.url?.slice(1);
  if (!["index.html", "capture.js", "capture.css"].includes(name)) { response.writeHead(404).end(); return; }
  response.setHeader("content-type", name.endsWith("js") ? "text/javascript" : name.endsWith("css") ? "text/css" : "text/html");
  response.end(await readFile(path.join(output, name)));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('[data-dashboard-capture="table"]');
  await page.evaluate(() => document.fonts.ready);
  const value = await page.evaluate(() => globalThis.captureWidget("value"));
  assert.deepEqual(value.layout.textBoxes.map(box => box.role.kind), ["title", "value", "unit"]);
  assert.ok(value.layout.textBoxes[1].rect[2] < value.layout.textBoxes[2].rect[0] + value.layout.textBoxes[2].rect[2]);
  const table = await page.evaluate(() => globalThis.captureWidget("table"));
  assert.equal(table.table.page, 0); assert.ok(table.layout.paint.length > table.layout.textBoxes.length);
  assert.ok(table.layout.textBoxes.some(box => box.role.kind === "cell" && box.role.column === "count"));
  const tools = table.layout.textBoxes.filter(box => box.role.kind === "tool");
  assert.deepEqual(tools.map(box => box.role.tool), ["csv", "excel"]);
  assert.ok(tools.every(box => box.buttonGroup && box.buttonGroup.rect[2] > 0 && box.buttonGroup.rect[3] > 0),
    "real export toolbar must capture a static button group");
  await page.locator('[data-capture-role="header"][data-capture-column="count"]').first().click();
  const sorted = await page.evaluate(() => globalThis.captureWidget("table"));
  assert.deepEqual(sorted.table.sort, { column: "count", direction: "asc" });
  const firstPage = await page.evaluate(() => globalThis.captureWidget("table", 1));
  assert.equal(firstPage.layout.textBoxes.find(box => box.role.kind === "previous").buttonGroup.opacity, 0.35);
  await page.locator('[data-dashboard-capture="table"]').nth(1).locator('[data-capture-role="next"]').click();
  const lastPage = await page.evaluate(() => globalThis.captureWidget("table", 1));
  assert.equal(lastPage.table.page, 1);
  assert.equal(lastPage.layout.textBoxes.find(box => box.role.kind === "next").buttonGroup.opacity, 0.35);
  assert.ok(lastPage.layout.textBoxes.some(box => box.role.kind === "cell" && box.role.row === 1));
  for (const width of [1280, 980]) {
    await page.setViewportSize({ width, height: 800 });
    await page.screenshot({ path: path.join(output, `capture-${width}.png`) });
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, "result.json"), JSON.stringify({ value, table, sorted, firstPage, lastPage }, null, 2));
  console.log("Real component DOM capture passed: value, table, sort, paint, 2 viewport screenshots.");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
