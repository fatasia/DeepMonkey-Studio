import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

/** 生成只在验收环境启用的可控 2D/3D 夹具，不污染正式产物。 */
export function buildVisualQaArtifact({ webRoot, outputRoot }) {
  const pnpmEntry = process.env.npm_execpath;
  if (!pnpmEntry) throw new Error("当前进程缺少 npm_execpath，无法定位 pnpm 运行入口");
  mkdirSync(outputRoot, { recursive: true });
  const result = spawnSync(process.execPath, [pnpmEntry, "exec", "vite", "build", "--outDir", outputRoot, "--emptyOutDir"], {
    cwd: webRoot,
    env: { ...process.env, VITE_VISUAL_QA: "true" },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    const reason = result.error instanceof Error ? result.error.message : `退出码 ${result.status}`;
    throw new Error(`视觉验收构建失败（${reason}）：\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
}

export function createStaticServer(root) {
  return createServer((request, response) => {
    const requestPath = decodeURIComponent(request.url?.split("?")[0] ?? "/");
    const requestedFile = requestPath === "/" ? "index.html" : requestPath.replace(/^\//, "");
    let filePath = resolve(root, requestedFile);
    if (!filePath.startsWith(`${root}${sep}`) || !existsSync(filePath)) filePath = resolve(root, "index.html");
    response.setHeader("content-type", contentType(filePath));
    createReadStream(filePath).pipe(response);
  });
}

function contentType(filePath) {
  const extension = extname(filePath);
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".wasm") return "application/wasm";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}
