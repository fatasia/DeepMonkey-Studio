import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/vsm-m2-diag");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/virtualShadowGpuProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const marker = process.env.VSM_PATCH_MARKER ?? "";
if (marker) {
  const bundled = await readFile(path.join(out, "probe.mjs"), "utf8");
  if (!bundled.includes(marker)) throw new Error("PATCH MARKER MISSING FROM BUNDLE: " + marker);
  console.error("[liveness] marker in bundle ok:", marker);
}
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") {
    response.setHeader("Content-Type", "text/javascript");
    response.setHeader("Cache-Control", "no-store");
    response.end(await readFile(path.join(out, "probe.mjs")));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end("<html><body style='background:#111'></body></html>");
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const MARKER_LITERAL = JSON.stringify(marker);
const FLOW = `(async () => {
    const pageSource = await (await fetch("/probe.mjs", { cache: "no-store" })).text();
    const probe = await import("/probe.mjs");
    await probe.beginLeg("virtual", true);
    await probe.settleLeg();
    const image = await probe.captureStill();
    const band = image.shadowBand;
    const column = [];
    for (let row = 0; row < band.height; row += 12) column.push(Math.round(band.luma[row * band.width + 48] * 1000) / 1000);
    return { markerInPage: pageSource.includes(${MARKER_LITERAL}), pageBytes: pageSource.length,
      lumaP05: image.lumaP05, lumaP95: image.lumaP95,
      edge: image.edge, column };
  })()`;
async function launch() {
  const chrome = spawn(process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    ["--headless=new", "--remote-debugging-port=0", "--enable-unsafe-webgpu", "--use-angle=default",
     "--no-first-run", "--disable-application-cache", "--disable-cache",
     `--user-data-dir=${path.join(out, "chrome-live-" + Date.now())}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] });
  const wsEndpoint = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("cdp timeout")), 30000);
    chrome.stderr.on("data", chunk => { buffer += chunk.toString();
      const m = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); } });
    chrome.on("exit", () => { clearTimeout(timer); reject(new Error("chrome exited")); });
  });
  const wsUrl = new URL(wsEndpoint);
  const targets = await (await fetch(`http://${wsUrl.host}/json/list`)).json();
  const page = targets.find(t => t.type === "page");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1; const pending = new Map();
  socket.onmessage = async event => {
    const text = typeof event.data === "string" ? event.data : await event.data.text();
    if (!text.trim()) return;
    const message = JSON.parse(text);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id); pending.delete(message.id);
      message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result);
    }
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => { pending.set(nextId, { resolve, reject });
      socket.send(JSON.stringify({ id: nextId++, method, params })); });
  }
  return { async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      return result.result?.value;
    }, async close() { try { socket.close(); } catch {} chrome.kill(); } };
}
let browser; const result = {};
try {
  browser = await launch();
  await browser.evaluate(`location.href = "http://127.0.0.1:${server.address().port}"`);
  await new Promise(r => setTimeout(r, 800));
  Object.assign(result, await browser.evaluate(FLOW));
} catch (error) { result.error = String(error); }
finally { if (browser) await browser.close(); server.close(); }
delete result.canvasPng;
console.log(JSON.stringify(result, null, 1));
