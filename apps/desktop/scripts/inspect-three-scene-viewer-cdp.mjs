import { writeFile } from "node:fs/promises";
import path from "node:path";

const port = Number(process.argv[2]);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Usage: node inspect-three-scene-viewer-cdp.mjs <port>");
const outputDirectory = process.argv[3];

const target = await waitForTarget(port);
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const operation = pending.get(message.id);
  if (!operation) return;
  pending.delete(message.id);
  if (message.error) operation.reject(new Error(message.error.message));
  else operation.resolve(message.result);
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Runtime evaluation failed");
  return response.result.value;
};

const snapshotExpression = `(() => {
  const dock = document.querySelector('.viewer-tool-dock');
  const toggle = document.querySelector('.viewer-tool-toggle');
  const canvas = document.querySelector('.scene-viewer-viewport canvas');
  const box = dock?.getBoundingClientRect();
  const style = dock ? getComputedStyle(dock) : undefined;
  return {
    readyState: document.readyState,
    title: document.title,
    url: location.href,
    fatal: document.querySelector('.scene-viewer-fatal')?.textContent ?? null,
    status: document.querySelector('.scene-viewer-status')?.textContent?.trim() ?? null,
    canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
    dock: dock ? {
      className: dock.className,
      ariaExpanded: toggle?.getAttribute('aria-expanded') ?? null,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      zIndex: style.zIndex,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    } : null,
  };
})()`;

const before = await evaluate(snapshotExpression);
if (outputDirectory) await capture(path.join(outputDirectory, "webview-before.png"));
const clicked = await evaluate(`(() => { const value = document.querySelector('.viewer-tool-toggle'); if (!value) return false; value.click(); return true; })()`);
await new Promise((resolve) => setTimeout(resolve, 350));
const after = await evaluate(snapshotExpression);
if (outputDirectory) await capture(path.join(outputDirectory, "webview-after-toggle.png"));
socket.close();
console.log(JSON.stringify({ target: { id: target.id, title: target.title, url: target.url }, clicked, before, after }, null, 2));

async function capture(filePath) {
  const result = await call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  await writeFile(filePath, Buffer.from(result.data, "base64"));
}

async function waitForTarget(debugPort) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const targets = await response.json();
        const match = targets.find((item) => item.type === "page" && typeof item.webSocketDebuggerUrl === "string");
        if (match) return match;
      }
    } catch { /* wait for WebView2 */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`WebView2 CDP target did not appear on port ${debugPort}`);
}
