/**
 * 服务日志消息人性化渲染：pino 序列化原文（`incoming request · {"level":30,...}`）
 * 解析为 `GET /api/x 200 3.15ms`。异常结构或额外诊断信息保留原文；调用方保留原文入口。
 */
export function formatServiceLogMessage(message: string): string {
  const separator = message.indexOf(" · ");
  const head = separator >= 0 ? message.slice(0, separator) : message;
  const tail = separator >= 0 ? message.slice(separator + 3) : "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch {
    return message;
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => !SUMMARY_FIELDS.has(key))) return message;
  const req = parsed.req;
  const res = parsed.res;
  if (req !== undefined && (!isRecord(req)
    || Object.keys(req).some((key) => !REQUEST_FIELDS.has(key))
    || typeof req.method !== "string" || !req.method.trim()
    || typeof req.url !== "string" || !req.url.trim())) return message;
  if (res !== undefined && (!isRecord(res)
    || Object.keys(res).some((key) => key !== "statusCode")
    || typeof res.statusCode !== "number" || !Number.isInteger(res.statusCode)
    || res.statusCode < 100 || res.statusCode > 599)) return message;
  for (const value of [parsed.responseTime, parsed.elapsedTime]) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return message;
  }
  if (parsed.url !== undefined && typeof parsed.url !== "string") return message;
  const responseTime = parsed.responseTime ?? parsed.elapsedTime;
  const parts: string[] = [];
  if (head.trim()) parts.push(head.trim());
  if (isRecord(req)) {
    parts.splice(head.includes("request") ? 1 : parts.length, 0, `${req.method} ${req.url}`);
  } else if (typeof parsed.url === "string" && !head.includes(" ")) {
    parts.push(String(parsed.url));
  }
  if (isRecord(res)) parts.push(String(res.statusCode));
  if (typeof responseTime === "number") parts.push(`${responseTime.toFixed(responseTime < 10 ? 2 : 0)}ms`);
  if (parts.length <= 1) return message;
  return parts.join(" ");
}

// 仅压缩标准请求信封；错误栈、冲突版本等业务诊断必须直接可见。
const SUMMARY_FIELDS = new Set(["level", "time", "pid", "hostname", "reqId", "req", "res", "url", "responseTime", "elapsedTime"]);
const REQUEST_FIELDS = new Set(["method", "url", "hostname", "remoteAddress", "remotePort"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 用户名尚未解析时保留用户 ID，不把机器标识误归因为系统操作。 */
export function formatAuditActor(username: string | null | undefined, systemLabel: string): string {
  const value = username?.trim();
  if (!value) return systemLabel;
  return value;
}
