// one-off: serve probe8 page and print results
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
const probeDir = resolve(repositoryRoot, "test-output/a01x-babylon-capture-probe");
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(request.url?.split("?")[0] ?? "/");
  let filePath, contentType;
  if (pathname === "/") { filePath = resolve(probeDir, "probe8.html"); contentType = "text/html; charset=utf-8"; }
  else if (pathname === "/probe8.js") { filePath = resolve(probeDir, "probe8.js"); contentType = "text/javascript; charset=utf-8"; }
  else if (pathname.startsWith("/vendor/")) {
    const name = pathname.slice("/vendor/".length);
    if (!/^[\w.-]+\.js$/.test(name)) { response.writeHead(403).end(); return; }
    filePath = resolve(probeDir, "vendor", name); contentType = "text/javascript; charset=utf-8";
  } else { response.writeHead(404).end(); return; }
  try { response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }).end(readFileSync(filePath)); }
  catch { response.writeHead(404).end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? String.fromCharCode(67)+":"+String.fromCharCode(92)+"Program Files"+String.fromCharCode(92)+"Google"+String.fromCharCode(92)+"Chrome"+String.fromCharCode(92)+"Application"+String.fromCharCode(92)+"chrome.exe";
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("console", (m) => console.log(`[page ${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  page.on("request", (r) => console.log(`[req] ${r.url()}`));
  page.on("requestfailed", (r) => console.log(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
  await page.goto(origin, { waitUntil: "load", timeout: 60_000 });
  try {
    await page.waitForFunction(() => window.__probeDone === true, undefined, { timeout: 120_000 });
  } catch {
    console.log("[timeout] out=", await page.locator("#out").textContent().catch(() => "<none>"));
    throw new Error("probe8 timeout");
  }
  const results = await page.evaluate(() => window.__probeResults);
  console.log(JSON.stringify({ results, errors }, null, 2));
} finally {
  await browser.close().catch(() => {});
  await new Promise((closed) => server.close(() => closed()));
}
