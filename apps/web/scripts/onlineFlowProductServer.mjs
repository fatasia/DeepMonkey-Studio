import { createReadStream, existsSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { extname, resolve, sep } from "node:path";

/** 为生产产物提供静态文件，并把 API、资产和 WebSocket 透明代理到测试 API。 */
export function createProductServer(root, upstreamOrigin) {
  const server = createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(request.url?.split("?")[0] ?? "/");
      const requestedFile = requestPath === "/" ? "index.html" : requestPath.replace(/^\//, "");
      const staticCandidate = resolve(root, requestedFile);
      const hasStaticAsset = staticCandidate.startsWith(`${root}${sep}`) && existsSync(staticCandidate);
      if (requestPath === "/health" || requestPath.startsWith("/api/") || (requestPath.startsWith("/assets/") && !hasStaticAsset)) {
        await proxyRequest(request, response, upstreamOrigin);
        return;
      }
      const filePath = hasStaticAsset ? staticCandidate : resolve(root, "index.html");
      response.setHeader("content-type", contentType(filePath));
      createReadStream(filePath).pipe(response);
    } catch (reason) {
      response.statusCode = 502;
      response.end(reason instanceof Error ? reason.message : String(reason));
    }
  });
  server.on("upgrade", (request, socket, head) => proxyWebSocket(request, socket, head, upstreamOrigin));
  return server;
}

function proxyWebSocket(request, socket, head, upstreamOrigin) {
  const upstreamUrl = new URL(upstreamOrigin);
  const upstream = connect(Number(upstreamUrl.port), upstreamUrl.hostname, () => {
    const headers = Object.entries(request.headers)
      .filter(([name]) => name.toLowerCase() !== "host")
      .flatMap(([name, value]) => Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : value === undefined ? [] : [`${name}: ${value}`]);
    headers.push(`host: ${upstreamUrl.host}`);
    upstream.write(`${request.method ?? "GET"} ${request.url ?? "/"} HTTP/${request.httpVersion}\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

async function proxyRequest(request, response, upstreamOrigin) {
  const body = await readRequestBody(request);
  const headers = { ...request.headers };
  delete headers.host;
  delete headers["content-length"];
  const upstream = await fetch(new URL(request.url ?? "/", upstreamOrigin), {
    method: request.method,
    headers,
    ...(body.length ? { body } : {}),
    redirect: "manual"
  });
  response.statusCode = upstream.status;
  upstream.headers.forEach((value, name) => {
    if (name !== "content-encoding" && name !== "content-length" && name !== "transfer-encoding") response.setHeader(name, value);
  });
  const payload = Buffer.from(await upstream.arrayBuffer());
  response.setHeader("content-length", payload.length);
  response.end(payload);
}

function readRequestBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
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
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".ttf") return "font/ttf";
  return "application/octet-stream";
}
