import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import pw from "../../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js";

const base = process.env.WASM_ENGINE_URL ?? "http://localhost:5177";
const out = new URL("../../../test-output/wasm-full-engine/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(out, { recursive: true });

const browser = await pw.chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const messages = [];
page.on("pageerror", (error) => messages.push({ type: "pageerror", text: error.message }));
page.on("console", (message) => messages.push({ type: message.type(), text: message.text() }));

const runtimeFontUrl = process.env.WASM_RUNTIME_FONT_URL;
const runtimeFontSha256 = process.env.WASM_RUNTIME_FONT_SHA256;
await page.goto(`${base}/dev/engine.html?canvas=page`, { waitUntil: "load" });
await page.waitForFunction(() => globalThis.__engineGlueReady === true, undefined, { timeout: 10_000 });
if (runtimeFontUrl) {
  if (!runtimeFontSha256) throw new Error("WASM_RUNTIME_FONT_SHA256 is required with WASM_RUNTIME_FONT_URL");
  await page.evaluate(
    async ({ url, sha256 }) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`runtime font fetch failed: HTTP ${response.status}`);
      globalThis.__engineGlue.setRuntimeFonts([
        {
          locale: "zh-CN",
          bytes: new Uint8Array(await response.arrayBuffer()),
          sha256,
          faceIndex: 0,
        },
      ]);
    },
    { url: runtimeFontUrl, sha256: runtimeFontSha256 },
  );
}
await page.evaluate(() => globalThis.__engineGlue.start());
try {
  await page.waitForFunction(() => globalThis.__engineGlue?.running === true, undefined, { timeout: 30_000 });
} catch (error) {
  const diagnostic = await page.evaluate(() => ({
    glue: globalThis.__engineGlue,
    ready: globalThis.__engineGlueReady,
    status: document.querySelector("#status")?.textContent,
    errorText: document.querySelector("#err")?.textContent,
  }));
  await page.screenshot({ path: `${out}startup-failed.png` });
  writeFileSync(`${out}startup-failed.json`, JSON.stringify({ diagnostic, messages, error: String(error) }, null, 2));
  console.error(JSON.stringify({ diagnostic, messages }));
  await browser.close();
  process.exit(1);
}
await page.waitForTimeout(3_000);
const preCapture = await Promise.race([
  page.evaluate(() => ({
    status: document.querySelector("#status")?.textContent,
    glue: globalThis.__engineGlue,
  })),
  new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 5_000)),
]);
let before;
try {
  before = await page.screenshot({ path: `${out}page-canvas-before.png`, timeout: 10_000 });
} catch (error) {
  writeFileSync(`${out}capture-failed.json`, JSON.stringify({ preCapture, messages, error: String(error) }, null, 2));
  console.error(JSON.stringify({ preCapture, messages, error: String(error) }));
  await browser.close();
  process.exit(1);
}
const canvas = page.locator("#host canvas");
const bounds = await canvas.boundingBox();
if (!bounds) throw new Error("full-engine canvas is missing");
await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
await page.mouse.down();
await page.mouse.move(bounds.x + bounds.width * 0.68, bounds.y + bounds.height * 0.43, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(1_000);
const after = await page.screenshot({ path: `${out}page-canvas-after-input.png` });
const state = await page.evaluate(() => ({
  glue: globalThis.__engineGlue,
  status: document.querySelector("#status")?.textContent,
  canvas: [...document.querySelectorAll("canvas")].map((item) => ({ width: item.width, height: item.height })),
}));
const result = {
  state,
  beforeSha256: createHash("sha256").update(before).digest("hex"),
  afterSha256: createHash("sha256").update(after).digest("hex"),
  inputChangedFrame: !before.equals(after),
  errors: messages.filter((item) => item.type === "error" || item.type === "pageerror"),
  warnings: messages.filter((item) => item.type === "warning"),
};
writeFileSync(`${out}browser-e2e.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
await browser.close();

if (!result.state.glue?.running || result.state.glue?.surface?.kind !== "full-engine") process.exitCode = 1;
if (result.errors.length || !result.inputChangedFrame) process.exitCode = 1;
