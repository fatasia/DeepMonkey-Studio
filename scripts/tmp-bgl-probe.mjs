import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const server = createServer((request, response) => { response.setHeader("Content-Type", "text/html"); response.end("<html><body></body></html>"); });
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
const executablePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({ headless: true, executablePath,
  args: process.env.BIM_STUDIO_CHROME_ARGS?.split(" ").filter(Boolean) ?? [] });
const page = await browser.newPage();
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
await page.goto(`http://127.0.0.1:${server.address().port}`);
const result = await page.evaluate(async () => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const out = [];
  device.addEventListener("uncapturederror", e => out.push("uncaptured: " + e.error.message));
  const probe = async (label, entries) => {
    device.pushErrorScope("validation");
    const layout = device.createBindGroupLayout({ label, entries });
    device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const error = await device.popErrorScope();
    return `${label}: ${error ? error.message : "VALID"}`;
  };
  const head = await probe("HEAD-3-entry", [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 640 } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
  ]);
  const extended = await probe("B1-6-entry", [
    { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 640 } },
    { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth", viewDimension: "2d-array" } },
    { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
    { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d-array" } },
  ]);
  return [head, extended, out];
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
await new Promise(resolve => server.close(resolve));
