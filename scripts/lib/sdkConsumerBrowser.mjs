import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isWithin } from "./sdkConsumerPackages.mjs";

export async function bundleConsumer({ consumer, reportDir, esbuild }) {
  const outfile = join(consumer, "out/browser/bundle.js");
  const result = await esbuild.build({ absWorkingDir: consumer, entryPoints: ["browser.ts"],
    outfile, bundle: true, platform: "browser", format: "esm", target: "es2023", conditions: ["browser"],
    metafile: true, logLevel: "silent", tsconfig: join(consumer, "tsconfig.browser.json") });
  assert.deepEqual(result.warnings, [], "No browser bundler warnings");
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.length > 3, "The bundle must contain installed SDK runtime code");
  for (const input of inputs) {
    assert.ok(isWithin(consumer, resolve(consumer, input)), `Unexpected external source input: ${input}`);
    assert.ok(!/(^|\/)(?:react|three|src)\//.test(input), `Runtime must use SDK dist, not renderer/UI/source: ${input}`);
  }
  for (const output of Object.values(result.metafile.outputs)) assert.deepEqual(output.imports, [], "Browser output must be self-contained");
  await writeFile(join(reportDir, "browser-metafile.json"), JSON.stringify(result.metafile, null, 2));
  return { outfile, inputs, bytes: (await readFile(outfile)).byteLength };
}

export async function checkBrowser({ root, consumer, reportDir, bundle, expected }) {
  const { default: playwright } = await import(pathToFileURL(join(root, "apps/cloud-render-worker/node_modules/playwright-core/index.js")).href);
  const html = await readFile(join(consumer, "index.html"));
  const script = await readFile(bundle.outfile);
  const server = createServer((request, response) => {
    if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); response.end(html); }
    else if (request.url === "/bundle.js") { response.writeHead(200, { "Content-Type": "text/javascript" }); response.end(script); }
    else if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const issues = [], requests = [];
  let browser;
  try {
    browser = await playwright.chromium.launch({ executablePath: process.env.SDK_GATE_CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const context = await browser.newContext({ viewport: { width: 1120, height: 740 }, serviceWorkers: "block" });
    await context.route("**/*", route => {
      const url = route.request().url();
      if (new URL(url).origin !== baseUrl) { issues.push(`Unexpected external request: ${url}`); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on("console", message => { if (["error", "warning"].includes(message.type())) issues.push(`${message.type()}: ${message.text()}`); });
    page.on("pageerror", error => issues.push(`pageerror: ${error.message}`));
    page.on("request", request => requests.push({ url: request.url(), method: request.method() }));
    page.on("response", response => { if (response.status() >= 400) issues.push(`HTTP ${response.status()}: ${response.url()}`); });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator('output[data-status="passed"]').waitFor({ timeout: 15_000 });
    const observed = JSON.parse(await page.locator("output").innerText());
    assert.deepEqual(observed, expected, "Installed Node and browser package behavior must match");
    assert.deepEqual(issues, []);
    assert.ok(requests.every(request => request.method === "GET" && new URL(request.url).origin === baseUrl));
    await page.screenshot({ path: join(reportDir, "sdk-consumer-browser.png"), fullPage: true });
    return { version: browser.version(), observed, issues, requests, screenshot: "sdk-consumer-browser.png" };
  } finally {
    await browser?.close();
    await new Promise(resolveClose => server.close(resolveClose));
    await writeFile(join(reportDir, "browser-observations.json"), JSON.stringify({ issues, requests }, null, 2));
  }
}
