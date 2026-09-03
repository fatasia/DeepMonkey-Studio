import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import type {
  ServiceHealthRecord,
  ServiceLogEntry,
  ServiceLogLevel,
  ServiceLogQueryResult,
  SystemDiagnosticSnapshot,
} from "@bim-studio/contracts";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const MAX_LOG_BYTES_PER_FILE = 512 * 1024;
const MAX_LOG_ENTRIES = 4_000;

export interface ServiceLogFilters {
  service?: string;
  level?: ServiceLogLevel;
  from?: string;
  to?: string;
  keyword?: string;
  limit: number;
}

export function normalizeServiceLogFilters(query: {
  service?: string;
  level?: string;
  from?: string;
  to?: string;
  keyword?: string;
  limit?: string;
}): ServiceLogFilters {
  const level = query.level?.trim();
  if (level && !["debug", "info", "warn", "error"].includes(level)) throw new Error("日志级别仅支持 debug、info、warn、error");
  const from = optionalTimestamp(query.from, "开始时间");
  const to = optionalTimestamp(query.to, "结束时间");
  if (from && to && Date.parse(from) > Date.parse(to)) throw new Error("日志开始时间不能晚于结束时间");
  return {
    ...(query.service?.trim() ? { service: query.service.trim().slice(0, 80) } : {}),
    ...(level ? { level: level as ServiceLogLevel } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(query.keyword?.trim() ? { keyword: query.keyword.trim().slice(0, 200) } : {}),
    limit: boundedInteger(query.limit, 300, 20, 1_000),
  };
}

export function serviceLogDirectories(dataDir: string): string[] {
  return [...new Set([path.join(dataDir, "logs"), path.join(repositoryRoot, ".runtime-logs")])];
}

export async function queryServiceLogs(directories: string[], filters: ServiceLogFilters): Promise<ServiceLogQueryResult> {
  const files = (await Promise.all(directories.map(listLogFiles))).flat();
  const services = [...new Set(files.map((file) => serviceName(file.name)))].sort();
  const batches = await Promise.all(files.map(readLogFile));
  const allEntries = batches.flatMap((batch) => batch.entries).slice(-MAX_LOG_ENTRIES);
  const keyword = filters.keyword?.toLocaleLowerCase("zh-CN");
  const matched = allEntries.filter((entry) =>
    (!filters.service || entry.service === filters.service) &&
    (!filters.level || entry.level === filters.level) &&
    (!filters.from || Date.parse(entry.timestamp) >= Date.parse(filters.from)) &&
    (!filters.to || Date.parse(entry.timestamp) <= Date.parse(filters.to)) &&
    (!keyword || `${entry.service} ${entry.message}`.toLocaleLowerCase("zh-CN").includes(keyword)),
  ).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  return {
    items: matched.slice(0, filters.limit),
    total: matched.length,
    truncated: matched.length > filters.limit || batches.some((batch) => batch.truncated),
    services,
    generatedAt: new Date().toISOString(),
  };
}

export function serviceLogExportText(result: ServiceLogQueryResult, filters: ServiceLogFilters): string {
  const heading = [
    "# Industrial Studio 脱敏服务日志",
    `# 导出时间 ${result.generatedAt}`,
    `# 筛选 ${JSON.stringify(filters)}`,
    `# 匹配 ${result.total} 条${result.truncated ? "（已截断）" : ""}`,
  ];
  return `${heading.join("\n")}\n${result.items.map((entry) => `${entry.timestamp}\t${entry.level.toUpperCase()}\t${entry.service}\t${entry.message}`).join("\n")}\n`;
}

export async function collectServiceHealth(): Promise<ServiceHealthRecord[]> {
  const metadataStore = process.env.METADATA_STORE === "postgres" ? "postgres" : "json";
  const objectStore = process.env.OBJECT_STORE === "minio" ? "minio" : "local";
  return Promise.all([
    checkApiRuntime(),
    checkWeb(),
    checkTcp("node-red", "流程服务", configuredEndpoint("NODE_RED_URL", "http://127.0.0.1:1880")),
    checkTcp("media", "实时视频", configuredEndpoint("MEDIA_GATEWAY_CONTROL_URL", "http://127.0.0.1:9997")),
    checkVisionRuntime(),
    metadataStore === "postgres"
      ? checkTcp("postgres", "PostgreSQL", `tcp://${process.env.POSTGRES_HOST ?? "127.0.0.1"}:${boundedInteger(process.env.POSTGRES_PORT, 5432, 1, 65_535)}`)
      : notConfigured("postgres", "PostgreSQL", "当前使用本地 JSON 元数据存储"),
    objectStore === "minio"
      ? checkMinio()
      : notConfigured("minio", "对象存储", "当前使用本地文件对象存储"),
  ]);
}

export async function createDiagnosticSnapshot(dataDir: string): Promise<SystemDiagnosticSnapshot> {
  const [health, logs] = await Promise.all([
    collectServiceHealth(),
    queryServiceLogs(serviceLogDirectories(dataDir), { level: "error", limit: 300 }),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    runtime: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      metadataStore: process.env.METADATA_STORE === "postgres" ? "postgres" : "json",
      objectStore: process.env.OBJECT_STORE === "minio" ? "minio" : "local",
    },
    health,
    logs,
  };
}

export async function createDiagnosticArchive(snapshot: SystemDiagnosticSnapshot): Promise<Buffer> {
  const archive = new JSZip();
  archive.file("diagnostic.json", `${JSON.stringify(snapshot, null, 2)}\n`);
  archive.file("health.json", `${JSON.stringify(snapshot.health, null, 2)}\n`);
  archive.file("errors.log", serviceLogExportText(snapshot.logs, { level: "error", limit: 300 }));
  archive.file("README.txt", "Industrial Studio 诊断包仅包含运行版本、服务健康与已脱敏错误日志；不包含凭据、审计记录、项目数据或模型。\n");
  return archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
}

export function redactServiceLog(value: string): string {
  return value
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/((?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|authorization|cookie|session)["']?\s*[:=]\s*["']?)([^\s,"'};]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_JWT]");
}

async function listLogFiles(directory: string): Promise<Array<{ directory: string; name: string }>> {
  try {
    const names = await readdir(directory);
    return names.filter((name) => /\.(?:out|err)\.log$/i.test(name)).map((name) => ({ directory, name }));
  } catch {
    return [];
  }
}

async function readLogFile(file: { directory: string; name: string }): Promise<{ entries: ServiceLogEntry[]; truncated: boolean }> {
  const filePath = path.join(file.directory, file.name);
  const info = await stat(filePath).catch(() => undefined);
  if (!info?.isFile()) return { entries: [], truncated: false };
  const bytes = Math.min(info.size, MAX_LOG_BYTES_PER_FILE);
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, Math.max(0, info.size - bytes));
    const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    if (info.size > bytes) lines.shift();
    return {
      entries: lines.map((line, index) => parseLogLine(file.name, line, info.mtime, index)),
      truncated: info.size > bytes,
    };
  } finally {
    await handle.close();
  }
}

function parseLogLine(file: string, raw: string, fallbackTime: Date, index: number): ServiceLogEntry {
  let parsed: Record<string, unknown> | undefined;
  try {
    const candidate = JSON.parse(raw) as unknown;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) parsed = candidate as Record<string, unknown>;
  } catch { /* 普通文本日志按原行处理。 */ }
  const level = parseLevel(parsed?.level, raw, file);
  const timestamp = parseTimestamp(parsed?.time ?? parsed?.timestamp) ?? parseTimestamp(raw.match(/^\[?([^\]\s]+T[^\]\s]+)/)?.[1]) ?? fallbackTime.toISOString();
  const message = redactServiceLog(parsed ? [parsed.msg, nestedErrorMessage(parsed.err), raw].filter(Boolean).join(" · ") : raw);
  return {
    id: createHash("sha1").update(`${file}:${timestamp}:${index}:${raw}`).digest("hex"),
    service: serviceName(file),
    level,
    timestamp,
    message,
    file,
  };
}

function parseLevel(value: unknown, raw: string, file: string): ServiceLogLevel {
  if (typeof value === "number") return value >= 50 ? "error" : value >= 40 ? "warn" : value >= 30 ? "info" : "debug";
  const label = String(value ?? "").toLowerCase();
  if (["debug", "info", "warn", "error"].includes(label)) return label as ServiceLogLevel;
  if (/\b(error|fatal|exception|failed)\b/i.test(raw)) return "error";
  if (/\bwarn(?:ing)?\b/i.test(raw)) return "warn";
  if (/\binfo\b/i.test(raw)) return "info";
  if (/\bdebug\b/i.test(raw)) return "debug";
  if (/^minio\./i.test(file)) return "info";
  if (/\.err\.log$/i.test(file)) return "error";
  return "info";
}

function nestedErrorMessage(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const message = (value as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}

function serviceName(file: string): string {
  return file.replace(/\.(?:out|err)\.log$/i, "");
}

async function checkApiRuntime(): Promise<ServiceHealthRecord> {
  const started = performance.now();
  await Promise.resolve();
  return record("api", "API 服务", "healthy", "/api/admin/health", started, "当前健康请求已由 API 实际处理");
}

async function checkWeb(): Promise<ServiceHealthRecord> {
  const endpoint = process.env.WEB_ORIGIN ?? "http://127.0.0.1:5173";
  const started = performance.now();
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    const content = await response.text();
    const valid = response.ok && /<title>\s*Industrial Studio\s*<\/title>/i.test(content);
    return record("web", "Web 前端", valid ? "healthy" : "degraded", endpoint, started, valid ? "页面标识验证通过" : `HTTP ${response.status}，页面标识不匹配`);
  } catch (error) {
    return record("web", "Web 前端", "offline", endpoint, started, errorMessage(error));
  }
}

async function checkVisionRuntime(): Promise<ServiceHealthRecord> {
  const started = performance.now();
  try {
    const runtime = await import("onnxruntime-node");
    const available = typeof runtime.InferenceSession?.create === "function";
    return record("vision", "视觉推理", available ? "healthy" : "degraded", "ONNX Runtime（进程内）", started, available ? "运行时加载成功；模型状态在视觉中心核验" : "运行时未暴露推理会话");
  } catch (error) {
    return record("vision", "视觉推理", "offline", "ONNX Runtime（进程内）", started, errorMessage(error));
  }
}

async function checkMinio(): Promise<ServiceHealthRecord> {
  const base = process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000";
  const started = performance.now();
  try {
    const endpoint = new URL("/minio/health/live", base).toString();
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(1_500) });
    return record("minio", "对象存储", response.ok ? "healthy" : "degraded", base, started, response.ok ? "存活探针通过" : `存活探针 HTTP ${response.status}`);
  } catch (error) {
    return record("minio", "对象存储", "offline", base, started, errorMessage(error));
  }
}

async function checkTcp(id: ServiceHealthRecord["id"], name: string, endpoint: string): Promise<ServiceHealthRecord> {
  const started = performance.now();
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return record(id, name, "offline", endpoint, started, "端点配置无效");
  }
  const port = Number(parsed.port || (parsed.protocol === "https:" || parsed.protocol === "tcps:" ? "443" : parsed.protocol === "http:" ? "80" : ""));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return record(id, name, "offline", endpoint, started, "端点未配置有效端口");
  }
  const result = await new Promise<{ ok: boolean; message: string }>((resolve) => {
    const socket = new Socket();
    let settled = false;
    const done = (ok: boolean, message: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, message });
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => done(true, "TCP 连接成功"));
    socket.once("timeout", () => done(false, "连接超时"));
    socket.once("error", (error) => done(false, error.message));
    socket.connect(port, parsed.hostname);
  });
  return record(id, name, result.ok ? "healthy" : "offline", endpoint, started, result.message);
}

function notConfigured(id: ServiceHealthRecord["id"], name: string, message: string): ServiceHealthRecord {
  return { id, name, status: "not-configured", endpoint: "未配置", message, checkedAt: new Date().toISOString() };
}

function record(id: ServiceHealthRecord["id"], name: string, status: ServiceHealthRecord["status"], endpoint: string, started: number, message: string): ServiceHealthRecord {
  return { id, name, status, endpoint: safeEndpoint(endpoint), latencyMs: Math.max(0.1, Math.round((performance.now() - started) * 10) / 10), message, checkedAt: new Date().toISOString() };
}

function safeEndpoint(value: string): string {
  try {
    const endpoint = new URL(value);
    if (endpoint.username || endpoint.password) {
      endpoint.username = "[REDACTED]";
      endpoint.password = "";
    }
    return endpoint.toString();
  } catch {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
}

function configuredEndpoint(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function optionalTimestamp(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}格式无效`);
  return parsed.toISOString();
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240);
}
