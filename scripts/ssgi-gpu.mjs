import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * P2 SSGI 真机验收驱动(esbuild 打包 lab/screenSpaceGiGpuProbe.ts → headless
 * Chrome WebGPU,最小 CDP 驱动;模式与 scripts/sdf-gi-gpu.mjs 同构)。
 *
 * 生产保真:探针直接构造生产 ScreenSpaceGiPass + PbrTransientTexturePool +
 * DeviceSession,走 encode 同一入口。
 *
 * 门:①间接光可见(on 输出 − 基色的红通道渗透均值 > 0.01 且 > 蓝×2.5);
 * ②GPU/CPU 镜像奇偶(GI 增量 max|Δ| ≤ 0.05,含 f16 量化如实标注);
 * ③帧时预算(SSGI 帧 p95 增量 ≤ 6ms,120 帧独立 submit→完成墙钟,含队列开销);
 * ④同 seed 逐位确定、换 seed 旋转。
 * 证据:test-output/ssgi-20261006/acceptance.json
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/ssgi-20261006");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/screenSpaceGiGpuProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path.join(out, "probe.mjs")));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<!doctype html><html><head><meta charset="utf-8"></head>`
      + `<body><h1>P2 SSGI 真机探针</h1><div id="results"></div></body></html>`);
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
const result = { gate: undefined, evidence: undefined, error: undefined,
  executedAt: new Date().toISOString() };
try {
  browser = await launchCdpBrowser();
  await browser.evaluate(`location.href = "http://127.0.0.1:${server.address().port}"`);
  await new Promise(resolve => setTimeout(resolve, 800));
  console.error("[ssgi] running production probe...");
  result.evidence = await browser.evaluate(
    `(async () => (await import("/probe.mjs")).runSsgiGpuProbe())()`);
  result.gate = {
    bleedMeanRed: result.evidence?.bleed?.meanRed,
    bleedMeanBlue: result.evidence?.bleed?.meanBlue,
    bleedPass: result.evidence?.bleedGate?.pass === true,
    parityMaxAbsDiff: result.evidence?.parity?.maxAbsDiff,
    parityPass: result.evidence?.parity?.pass === true,
    sameSeedMaxAbsDiff: result.evidence?.determinism?.sameSeedMaxAbsDiff,
    determinismPass: result.evidence?.determinism?.pass === true,
    incrementP95ms: result.evidence?.frameTiming?.incrementP95,
    frameBudgetPass: result.evidence?.frameTiming?.pass === true,
    uncapturedErrors: result.evidence?.uncapturedErrors === true,
  };
  result.gate.pass = result.gate.bleedPass && result.gate.parityPass
    && result.gate.determinismPass && result.gate.frameBudgetPass && !result.gate.uncapturedErrors;
  console.error("[ssgi] gate:", JSON.stringify(result.gate));
} catch (error) {
  result.error = String(error?.message ?? error);
  console.error("[ssgi] FAILED:", result.error);
} finally {
  await writeFile(path.join(out, "acceptance.json"), JSON.stringify(result, null, 2));
  browser?.close();
  server.close();
}
if (!result.gate?.pass) process.exitCode = 1;
