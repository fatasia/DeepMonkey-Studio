import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { PARAMETRIC_CAD_TEMPLATES } from "@bim-studio/parametric-modeling-plugin";

const { chromium } = playwright;

const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distRoot = resolve(webRoot, "dist");
const assetsRoot = resolve(distRoot, "assets");
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
const workerName = readdirSync(assetsRoot).find((name) => /^parametricCad\.worker-.*\.js$/.test(name));
if (!workerName) throw new Error("未找到生产构建中的参数化 Worker，请先执行 Web build");

const server = createServer((request, response) => {
  const requestPath = decodeURIComponent(request.url?.split("?")[0] ?? "/") || "/";
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = resolve(distRoot, `.${normalizedPath}`);
  // 冒烟服务器只允许读取刚生成的 dist，不能成为任意本地文件代理。
  if (!filePath.startsWith(`${distRoot}${sep}`) || !existsSync(filePath)) {
    response.writeHead(404).end();
    return;
  }
  response.setHeader("content-type", contentType(filePath));
  createReadStream(filePath).pipe(response);
});

await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法创建本地冒烟服务器");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ executablePath: chromePath, headless: true });

try {
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.goto(`${origin}/?__visualQa=parametric&theme=dark`, { waitUntil: "domcontentloaded" });
  if (requests.some((url) => url.endsWith(".wasm"))) throw new Error("参数化 WASM 在创建 Worker 前被提前加载");

  const result = await page.evaluate(async ({ workerUrl, definition }) => {
    const id = crypto.randomUUID();
    const worker = new Worker(workerUrl, { type: "module", name: "parametric-production-smoke" });
    try {
      return await new Promise((resolveResult, reject) => {
        const timer = window.setTimeout(() => reject(new Error("参数化生产 Worker 在 120 秒内没有返回")), 120_000);
        worker.onerror = (event) => { window.clearTimeout(timer); reject(new Error(event.message || "Worker 异常")); };
        worker.onmessage = (event) => {
          if (event.data.id !== id) return;
          window.clearTimeout(timer);
          if (!event.data.ok) reject(new Error(event.data.error || "构建失败"));
          else resolveResult({
            summary: event.data.result.summary,
            vertexCount: event.data.result.vertices.length / 3,
            stepBytes: event.data.result.step.byteLength
          });
        };
        worker.postMessage({ id, definition });
      });
    } finally {
      worker.terminate();
    }
  }, { workerUrl: `${origin}/assets/${workerName}`, definition: structuredClone(PARAMETRIC_CAD_TEMPLATES[0].definition) });

  if (!requests.some((url) => url.endsWith(".wasm"))) throw new Error("构建期间未加载 OpenCascade WASM");
  if (result.summary.triangleCount <= 0 || result.summary.volumeMm3 <= 0 || result.vertexCount <= 0 || result.stepBytes <= 100) {
    throw new Error(`参数化构建结果不完整：${JSON.stringify(result)}`);
  }

  await page.getByRole("button", { name: "更新预览", exact: true }).click();
  await page.getByText("预览已就绪").waitFor({ timeout: 30_000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "GLB", exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("浏览器没有返回 GLB 下载文件");
  const glb = readFileSync(downloadPath);
  if (!download.suggestedFilename().endsWith(".glb")) throw new Error(`下载文件名不是 GLB：${download.suggestedFilename()}`);
  if (glb.subarray(0, 4).toString() !== "glTF" || glb.byteLength <= 128) throw new Error(`下载的 GLB 无效：${glb.byteLength} bytes`);

  console.log(`[parametric-browser-smoke] 通过：${result.summary.triangleCount} triangles, ${result.vertexCount} vertices, STEP ${result.stepBytes} bytes, ${result.summary.durationMs} ms`);
  console.log(`[parametric-browser-smoke] GLB 下载通过：${download.suggestedFilename()}，${glb.byteLength} bytes`);
} finally {
  await browser.close();
  await new Promise((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
}

function contentType(filePath) {
  const extension = extname(filePath);
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".wasm") return "application/wasm";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".html") return "text/html; charset=utf-8";
  return "application/octet-stream";
}
