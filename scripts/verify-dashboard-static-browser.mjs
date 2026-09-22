import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";

const [input, output, ...rest] = process.argv.slice(2);
assert(input && output && !rest.length, "Usage: node scripts/verify-dashboard-static-browser.mjs <package-root> <new-evidence-directory>");
const root = await realpath(input), evidence = path.resolve(output);
await mkdir(evidence); // 新证据目录，不覆盖历史运行。
const manifest = JSON.parse(await readFile(path.join(root, "dashboard.web.json"), "utf8"));
const resource = manifest.resources[0];
assert(resource, "Failure probes require a frozen resource");
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".wasm": "application/wasm", ".ttf": "font/ttf", ".otf": "font/otf", ".png": "image/png" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
    const prefix = ["/nested/deep/", "/tampered/", "/missing/"].find(value => url.pathname.startsWith(value)) ?? "/";
    const relative = decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
    const file = await realpath(path.resolve(root, relative)), confined = path.relative(root, file);
    if (!confined || confined === ".." || confined.startsWith(`..${path.sep}`) || path.isAbsolute(confined)) {
      response.writeHead(400).end(); return;
    }
    if (prefix === "/missing/" && relative === resource.path) { response.writeHead(404).end(); return; }
    const bytes = await readFile(file);
    if (prefix === "/tampered/" && relative === resource.path) bytes[bytes.length - 1] ^= 1;
    response.setHeader("content-type", types[path.extname(file)] ?? "application/octet-stream");
    response.setHeader("cache-control", "no-store"); response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await playwright.chromium.launch({ headless: true,
  executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const cases = [];

async function inspect(id, route, viewport, action, expectedFailure = false) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage(), errors = [], warnings = [], external = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "warning") warnings.push(message.text());
    if (message.type() === "error" && !expectedFailure) errors.push(message.text());
  });
  page.on("request", request => { if (!request.url().startsWith(origin) && /^https?:/.test(request.url())) external.push(request.url()); });
  const started = performance.now();
  try {
    await page.goto(origin + route, { waitUntil: "load" });
    if (expectedFailure) {
      await page.locator("main.dashboard-static-state[role=alert]").waitFor();
      assert.equal(await page.locator(".dashboard-static-root").count(), 0, "Failed package must not publish its view");
    } else {
      await page.locator(".dashboard-static-root canvas").first().waitFor();
      await page.waitForFunction(() => document.fonts.status === "loaded");
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (action) await action(page);
      const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
        controls: [...document.querySelectorAll(".dashboard-static-tools button,.dashboard-static-tools select")]
          .map(element => { const r = element.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom }; }) }));
      assert(layout.scroll <= layout.width, "Horizontal overflow");
      for (const control of layout.controls) assert(control.x >= 0 && control.right <= layout.width && control.y >= 0, "Clipped control");
    }
    assert.deepEqual(external, [], "Offline package issued external requests");
    assert.deepEqual(errors, [], "Browser runtime errors");
    assert.deepEqual(warnings, [], "Browser runtime warnings");
    await page.screenshot({ path: path.join(evidence, `${id}.png`) });
    cases.push({ id, passed: true, ms: performance.now() - started, errors, warnings, external });
  } catch (error) {
    cases.push({ id, passed: false, error: String(error), errors, warnings, external });
    await page.screenshot({ path: path.join(evidence, `${id}-failed.png`) }).catch(() => {});
  } finally { await context.close(); }
  console.log(`${cases.at(-1).passed ? "PASS" : "FAIL"} ${id}`);
}

try {
  for (let round = 1; round <= 2; round++) {
    for (const width of [1920, 980, 480]) for (const theme of ["dark", "light"])
      await inspect(`r${round}-${width}-${theme}`, `/?theme=${theme}`, { width, height: width === 1920 ? 1080 : 720 });
    await inspect(`r${round}-subdirectory`, "/nested/deep/", { width: 1280, height: 800 });
    await inspect(`r${round}-fullscreen-restore`, "/", { width: 1280, height: 800 }, async page => {
      await page.getByRole("button", { name: "全屏", exact: true }).click();
      await page.waitForFunction(() => Boolean(document.fullscreenElement));
      await page.getByRole("button", { name: "退出全屏", exact: true }).click();
      await page.waitForFunction(() => !document.fullscreenElement);
      await page.reload(); await page.locator(".dashboard-static-root canvas").first().waitFor();
    });
    await inspect(`r${round}-tampered`, "/tampered/", { width: 980, height: 720 }, undefined, true);
    await inspect(`r${round}-missing`, "/missing/", { width: 980, height: 720 }, undefined, true);
  }
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
  await writeFile(path.join(evidence, "result.json"), JSON.stringify({ createdAt: new Date().toISOString(),
    publicationId: manifest.publication.id, contentSha256: manifest.contentSha256, cases }, null, 2));
}
assert(cases.every(item => item.passed), `${cases.filter(item => !item.passed).length} browser checks failed`);
