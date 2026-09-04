import { get as getHttps } from "node:https";

const MAX_PROBE_BYTES = 1024 * 1024;

/** 只对回环地址的开发证书放宽校验，远程 HTTPS 始终走系统信任链。 */
export async function readHttpText(address, timeoutMs = 1_500) {
  const url = new URL(address);
  if (url.protocol !== "https:" || !isLoopback(url.hostname)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: response.ok, status: response.status, text: await response.text() };
  }
  return new Promise((resolve, reject) => {
    const request = getHttps(url, { rejectUnauthorized: false }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_PROBE_BYTES) {
          request.destroy(new Error("健康检查响应超过 1 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300),
        status: response.statusCode ?? 0,
        text: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("健康检查超时")));
    request.once("error", reject);
  });
}

function isLoopback(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
