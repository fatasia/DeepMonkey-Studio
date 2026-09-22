import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const repositoryRoot = resolve(resolve(fileURLToPath(new URL("..", import.meta.url))), "../..");
const probeDir = resolve(repositoryRoot, "test-output/a01x-babylon-capture-probe");
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(request.url?.split("?")[0] ?? "/");
  let filePath, contentType;
  if (pathname === "/") { filePath = resolve(probeDir, "probe5.html"); contentType = "text/html; charset=utf-8"; }
  else if (pathname === "/probe5.js") { filePath = resolve(probeDir, "probe5.js"); contentType = "text/javascript; charset=utf-8"; }
  else if (pathname.startsWith("/vendor/")) {
    const name = pathname.slice("/vendor/".length);
    if (!/^[\w.-]+\.js$/.test(name)) { response.writeHead(403).end(); return; }
    filePath = resolve(probeDir, "vendor", name); contentType = "text/javascript; charset=utf-8";
  } else { response.writeHead(404).end(); return; }
  try { response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }).end(readFileSync(filePath)); }
  catch { response.writeHead(404).end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const serverPort = server.address().port;
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:" + String.fromCharCode(92) + "Program Files" + String.fromCharCode(92) + "Google" + String.fromCharCode(92) + "Chrome" + String.fromCharCode(92) + "Application" + String.fromCharCode(92) + "chrome.exe";
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
try {
  for (const order of ["negative", "positive"]) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    await page.goto(`http://127.0.0.1:${serverPort}/?order=${order}`, { waitUntil: "load", timeout: 60_000 });
    try {
      await page.waitForFunction(() => window.__probeDone === true, undefined, { timeout: 150_000 });
      const results = await page.evaluate(() => window.__probeResults);
      console.log(JSON.stringify(results, null, 2));
    } catch {
      console.log(JSON.stringify({ order, timeout: true, errors }, null, 2));
    }
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
  await new Promise((closed) => server.close(() => closed()));
}
