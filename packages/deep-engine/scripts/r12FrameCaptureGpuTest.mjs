import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../../../", import.meta.url);
const output = new URL(`test-output/r12-frame-capture-${Date.now()}/`, root);
const bundle = await build({ entryPoints: [fileURLToPath(new URL("../lab/r12FrameCaptureProbe.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "browser", conditions: ["development"], write: false });
const server = createServer((request, response) => {
  if (request.url === "/probe.mjs") response.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].contents);
  else if (request.url === "/") response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>R12 frame capture</title>");
  else response.writeHead(204).end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const require = createRequire(import.meta.url);
const { chromium } = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async () => (await import("/probe.mjs")).runR12FrameCaptureProbe());
  const evidence = { ...result, success: result.success && errors.length === 0, errors,
    chrome: browser.version(), capturedAt: new Date().toISOString() };
  await mkdir(output, { recursive: true });
  await writeFile(new URL("evidence.json", output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ success: evidence.success, output: fileURLToPath(output),
    cases: evidence.cases.map(({ name, success, error }) => ({ name, success, error })), errors }, null, 2));
  if (!evidence.success) process.exitCode = 1;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
