import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";

const [frontendArg, outputArg] = process.argv.slice(2);
if (!frontendArg || !outputArg) throw new Error("Expected <staged frontend> <evidence output>");
const frontend = path.resolve(frontendArg), output = path.resolve(outputArg);
const marker = JSON.parse(await readFile(path.join(frontend, "delivery/scene-viewer.json"), "utf8"));
if (!marker.publication?.name?.startsWith("QA ")) throw new Error("Offline probe only serves named QA publications");
await mkdir(output, { recursive: true });
const requests = [], contentTypes = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml",
  ".png": "image/png", ".glb": "model/gltf-binary" };
// Static files only. No API proxy or original project-resource access exists here.
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1:4179").pathname);
  const file = path.resolve(frontend, `.${pathname}`);
  const relative = path.relative(frontend, file);
  let status = 200, bytes;
  try {
    if (relative.startsWith("..") || path.isAbsolute(relative) || pathname.startsWith("/api/")) throw new Error("Rejected path");
    bytes = await readFile((await stat(file)).isDirectory() ? path.join(file, "index.html") : file);
  } catch {
    if (!path.extname(pathname) && !pathname.startsWith("/api/")) bytes = await readFile(path.join(frontend, "index.html"));
    else { status = 404; bytes = Buffer.from("Not found"); }
  }
  requests.push({ path: pathname, status, bytes: bytes.length, at: new Date().toISOString() });
  response.writeHead(status, { "content-type": contentTypes[path.extname(pathname)] ?? (path.extname(pathname) ? "application/octet-stream" : "text/html"),
    "cache-control": "no-store" }).end(bytes);
  await writeFile(path.join(output, "offline-server-requests.json"), JSON.stringify({ frontend, apiProxy: false, requests }, null, 2));
});
server.listen(4179, "127.0.0.1", () => console.log("Isolated static viewer ready: http://127.0.0.1:4179"));
