import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const output = fileURLToPath(new URL("../../../test-output/wasm-product-integration/", import.meta.url));
await mkdir(output, { recursive: true });

const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
assert.equal(login.status, 200, `Studio login failed: HTTP ${login.status}`);
const { token } = await login.json();
assert.ok(token, "Studio login did not return a token");

const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});
const report = {
  createdAt: new Date().toISOString(),
  route: `/studio/${sceneId}?project=${projectId}`,
  errors: [],
  warnings: [],
  responses5xx: [],
  writes: [],
  screenshots: [],
};

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ token }) => {
    localStorage.setItem("bim-studio-auth-token", token);
    localStorage.setItem("bim-studio.renderer-backend", "webgl");
  }, { token });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => report.errors.push({ type: "pageerror", text: error.message }));
  page.on("console", message => {
    const entry = { type: message.type(), text: message.text() };
    if (message.type() === "error") report.errors.push(entry);
    else if (message.type() === "warning") report.warnings.push(entry);
  });
  page.on("response", response => {
    if (response.status() >= 500) report.responses5xx.push({ status: response.status(), url: response.url() });
  });
  page.on("request", request => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) report.writes.push(`${request.method()} ${request.url()}`);
  });

  await page.goto(`${webOrigin}${report.route}`, { waitUntil: "domcontentloaded" });
  await page.locator(".viewport canvas").first().waitFor({ state: "visible" });
  await page.waitForTimeout(2_000);
  const authorCanvas = page.locator(".viewport canvas:not([data-renderer-backend])").first();
  await authorCanvas.waitFor();

  await page.getByLabel("更多场景工具", { exact: true }).click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  await dialog.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "启用 Deep WASM", exact: true }).waitFor();

  const before = await page.screenshot({ path: `${output}studio-webgl-1280.png` });
  report.screenshots.push("studio-webgl-1280.png");
  await page.getByRole("button", { name: "启用 Deep WASM", exact: true }).click();
  const wasmCanvas = page.locator('.viewport canvas[data-renderer-backend="deep-wasm"]');
  await wasmCanvas.waitFor({ state: "attached", timeout: 45_000 });
  try {
    await page.waitForFunction(() => {
      const canvas = document.querySelector('.viewport canvas[data-renderer-backend="deep-wasm"]');
      return canvas && getComputedStyle(canvas).opacity === "1";
    }, undefined, { timeout: 45_000 });
  } catch (error) {
    report.activationDiagnostic = await page.evaluate(() => ({
      dialog: document.querySelector('[aria-label="渲染引擎设置"]')?.textContent,
      canvases: [...document.querySelectorAll(".viewport canvas")].map(canvas => ({
        backend: canvas.dataset.rendererBackend ?? "author-webgl",
        opacity: getComputedStyle(canvas).opacity,
        visibility: getComputedStyle(canvas).visibility,
        width: canvas.width,
        height: canvas.height,
      })),
    }));
    await page.screenshot({ path: `${output}studio-wasm-activation-failed.png` });
    throw error;
  }
  await dialog.getByRole("button", { name: "正在使用", exact: true }).waitFor({ timeout: 45_000 });

  report.active = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll(".viewport canvas")];
    return canvases.map(canvas => ({
      backend: canvas.dataset.rendererBackend ?? "author-webgl",
      opacity: getComputedStyle(canvas).opacity,
      pointerEvents: getComputedStyle(canvas).pointerEvents,
      width: canvas.width,
      height: canvas.height,
    }));
  });
  const author = report.active.find(item => item.backend === "author-webgl");
  const wasm = report.active.find(item => item.backend === "deep-wasm");
  assert.equal(author?.opacity, "0", "author canvas must yield presentation after WASM is ready");
  assert.equal(author?.pointerEvents, "auto", "author canvas must retain input ownership");
  assert.equal(wasm?.opacity, "1", "WASM canvas must own presentation");

  const activeFrame = await page.screenshot({ path: `${output}studio-wasm-1280.png` });
  report.screenshots.push("studio-wasm-1280.png");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  const bounds = await authorCanvas.boundingBox();
  assert.ok(bounds && bounds.width > 100 && bounds.height > 100, "author input canvas has no usable bounds");
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.68, bounds.y + bounds.height * 0.42, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1_000);
  const afterInput = await page.screenshot({ path: `${output}studio-wasm-after-camera.png` });
  report.screenshots.push("studio-wasm-after-camera.png");
  report.cameraInputChangedFrame = !activeFrame.equals(afterInput);
  report.frameHashes = {
    before: createHash("sha256").update(before).digest("hex"),
    active: createHash("sha256").update(activeFrame).digest("hex"),
    afterInput: createHash("sha256").update(afterInput).digest("hex"),
  };
  assert.ok(report.cameraInputChangedFrame, "camera input did not change the WASM presentation frame");

  await page.getByLabel("更多场景工具", { exact: true }).click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  await dialog.waitFor({ state: "visible" });
  report.layouts = [];
  for (const width of [1920, 1280, 980, 800, 480]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {
        width: innerWidth,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
      };
    });
    layout.insideViewport = layout.left >= -1 && layout.right <= width + 1 && layout.top >= -1 && layout.bottom <= 801;
    report.layouts.push(layout);
    assert.ok(layout.insideViewport, `renderer dialog clipped at ${width}px: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: `${output}renderer-dialog-${width}.png` });
    report.screenshots.push(`renderer-dialog-${width}.png`);
  }

  report.savedPreference = await page.evaluate(() => localStorage.getItem("bim-studio.renderer-backend"));
  assert.equal(report.savedPreference, "wasm", "WASM preference was not committed after activation");
  assert.deepEqual(report.responses5xx, [], `HTTP 5xx observed: ${JSON.stringify(report.responses5xx)}`);
  assert.ok(report.errors.every(item => item.text.includes("favicon")), `browser errors: ${JSON.stringify(report.errors)}`);
  report.passed = true;
  await context.close();
} catch (error) {
  report.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  report.passed = false;
  throw error;
} finally {
  await browser.close();
  await writeFile(`${output}studio-integration-report.json`, JSON.stringify(report, null, 2));
}

console.log(JSON.stringify(report, null, 2));
