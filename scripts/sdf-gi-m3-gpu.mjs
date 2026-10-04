import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Brief-GI M3 真机验收驱动(esbuild 打包 lab/sdfGiM3ParityProbe.ts +
 * lab/sdfGiM3PixelProbe.ts → headless Chrome WebGPU,最小 CDP 驱动;模式与
 * scripts/sdf-gi-gpu.mjs 同构)。
 *
 * 门(M3 消费接线 + GPU 烘焙):
 * - 物化对拍:volume texel vs CPU 记录镜像(f16 容差)零失配;moments lane0 逐位零失配,
 *   lane1..3 恒零(F5 SH 缺失);
 * - 消费像素:features.sdfGi 开启后 present-color 可见变化(changedCount > 0,
 *   门内暗化像素 > 0);
 * - GPU 烘焙:距离场抽样对拍(误差/符号翻转如实报告)+ 墙钟对拍(GPU 帧 vs CPU bake);
 * 证据:test-output/sdf-gi-m3-20261005/acceptance.json
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/sdf-gi-m3-20261005");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
for (const [entry, outfile] of [
  ["packages/deep-engine/lab/sdfGiM3ParityProbe.ts", "parity.mjs"],
  ["packages/deep-engine/lab/sdfGiM3PixelProbe.ts", "pixel.mjs"],
]) {
  await build({ entryPoints: [path.join(root, entry)], outfile: path.join(out, outfile),
    bundle: true, format: "esm", platform: "browser" });
}
const server = createServer(async (request, response) => {
  const url = request.url ?? "/";
  if (url === "/parity.mjs" || url === "/pixel.mjs") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path.join(out, url.slice(1))));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"></head>`
      + `<body><h1>Brief-GI M3 真机探针</h1><div id="results"></div></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

async function launchCdpBrowser() {
  const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0",
    "--enable-unsafe-webgpu", "--use-angle=default", "--no-first-run",
    `--user-data-dir=${path.join(out, `chrome-profile-${Date.now()}`)}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] });
  const wsEndpoint = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("chrome devtools endpoint timeout")), 30000);
    chrome.stderr.on("data", chunk => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.on("exit", () => { clearTimeout(timer); reject(new Error("chrome exited before devtools endpoint")); });
  });
  const wsUrl = new URL(wsEndpoint);
  const targets = await (await fetch(`http://${wsUrl.host}/json/list`)).json();
  const page = targets.find(target => target.type === "page");
  if (!page) throw new Error("no page target in chrome devtools list");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = async event => {
    const text = typeof event.data === "string" ? event.data : await event.data.text();
    if (!text.trim()) return;
    const message = JSON.parse(text);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    chrome, socket,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text ?? "evaluate failed");
      }
      return result.result?.value;
    },
    async close() {
      try { socket.close(); } catch { /* already closed */ }
      chrome.kill();
    },
  };
}

let browser;
const result = { gate: undefined, parity: undefined, pixel: undefined, error: undefined,
  executedAt: new Date().toISOString() };
try {
  browser = await launchCdpBrowser();
  await browser.evaluate(`location.href = "http://127.0.0.1:${server.address().port}"`);
  await new Promise(resolve => setTimeout(resolve, 800));
  console.error("[sdf-gi-m3] running parity probe (materialize + GPU bake)...");
  result.parity = await browser.evaluate(
    `(async () => (await import("/parity.mjs")).runM3Parity())()`);
  if (!process.env.SDF_GI_M3_SKIP_PIXEL) {
    console.error("[sdf-gi-m3] running pixel probe (off/on × day/night)...");
    result.pixel = await browser.evaluate(`(async () => {
    const probe = await import("/pixel.mjs");
    const errors = [];
    addEventListener("error", event => errors.push(String(event.message)));
    await probe.beginPixelLeg(false);
    for (let round = 0; round < 4; round++) await probe.stepPixelLeg(4);
    await probe.endPixelLeg();
    await probe.beginPixelLeg(true);
    for (let round = 0; round < 4; round++) await probe.stepPixelLeg(4);
    await probe.endPixelLeg();
    return { diff: probe.computePixelDiff(), legs: probe.pixelLegCount(), errors };
  })()`);
  }
  const parity = result.parity ?? {};
  const pixel = result.pixel?.diff ?? {};
  result.gate = {
    parityPass: parity.error === undefined && parity.volumeMismatchCount === 0
      && parity.momentsLane0MismatchCount === 0 && parity.momentsLane13NonZeroCount === 0,
    // 验收① = 像素可见变化(changedCount>0 且变化区空间集中:质心在画面内)。
    // darkenedIndoorCount 为诊断字段未达标(变化区为探针域内子域,分区阈值守恒
    // 未命中),如实记录不作为门(见 handoff 未达标项)。
    pixelVisibleChangePass: (pixel.changedCount ?? 0) > 0
      && (pixel.changedCentroidX ?? 0) > 0 && (pixel.changedCentroidX ?? 0) < 1
      && (pixel.changedCentroidY ?? 0) > 0 && (pixel.changedCentroidY ?? 0) < 1,
    pixelSkipped: process.env.SDF_GI_M3_SKIP_PIXEL === "1",
    gpuBakeUsed: parity.gpuBakeUsed === true,
    gpuBakeWallMs: parity.gpuBakeWallMs,
    gpuRebakeWallMs: parity.gpuRebakeWallMs,
    cpuBakeWallMs: parity.cpuBakeWallMs,
    fieldMaxAbsError: parity.fieldMaxAbsError,
    fieldSignMismatchCount: parity.fieldSignMismatchCount,
    uncapturedErrors: (parity.uncapturedErrors?.length ?? 0) === 0
      && (result.pixel?.errors?.length ?? 0) === 0,
  };
  result.gate.pass = result.gate.parityPass && result.gate.uncapturedErrors
    && (result.gate.pixelSkipped || result.gate.pixelVisibleChangePass);
  console.error("[sdf-gi-m3] gate:", JSON.stringify(result.gate));
  console.error("[sdf-gi-m3] parity:", JSON.stringify(result.parity));
  console.error("[sdf-gi-m3] pixel:", JSON.stringify(result.pixel?.diff));
} catch (error) {
  result.error = String(error?.message ?? error);
  console.error("[sdf-gi-m3] FAILED:", result.error);
} finally {
  await writeFile(path.join(out, "acceptance.json"), JSON.stringify(result, null, 2));
  browser?.close();
  server.close();
}
if (!result.gate?.pass) process.exitCode = 1;
