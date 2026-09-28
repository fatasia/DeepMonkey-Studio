import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import playwright from "../../../apps/cloud-render-worker/node_modules/playwright-core/index.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
const bundle = await build({ absWorkingDir: join(directory, ".."), entryPoints: ["lab/t00S1FactoryProbe.ts"],
  bundle: true, format: "iife", platform: "browser", target: "es2022", conditions: ["development"], write: false });
const output = process.argv[2] ?? "docs/reports/deep-core/assets/t00-s1-factory-browser-2026-09-27.json";
await mkdir(dirname(output), { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
  ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1 });
  const messages = [];
  page.on("pageerror", error => messages.push(String(error)));
  await page.goto("http://127.0.0.1:5291/benchmark", { waitUntil: "networkidle" });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const cases = [];
  for (const count of [1, 1024, 10000]) {
    const result = await page.evaluate(async value => await globalThis.__t00S1FactoryProbe(value), count);
    await page.locator("#asset").selectOption("FactoryMachine");
    await page.locator("#count").selectOption(String(count));
    await page.locator("#benchmark-status").evaluate((element, value) => {
      element.textContent = `T00 S1 / ${value.toLocaleString()} 台工业机器 · Deep 单帧画质参考`;
    }, count);
    const screenshot = output.replace(/\.json$/, `-${count}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    const canvasScreenshot = output.replace(/\.json$/, `-${count}-canvas.png`);
    await page.locator("#candidate-canvas").screenshot({ path: canvasScreenshot });
    cases.push({ ...result, screenshot, canvasScreenshot });
  }
  const result = { schema: 1, browser: browser.version(), cases, pageErrors: messages };
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }
