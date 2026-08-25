import { existsSync } from "node:fs";
import { hostname } from "node:os";

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface CloudRenderWorkerConfig {
  workerId: string;
  host: string;
  port: number;
  token: string;
  publicOrigin: string;
  chromiumPath: string;
  headless: boolean;
  maxSessions: number;
  navigationTimeoutMs: number;
  canvasTimeoutMs: number;
  iceGatheringTimeoutMs: number;
  iceServers: IceServerConfig[];
  gpuMemoryMiB?: number;
  verifiedHardwareCodecs: Array<"h264" | "h265" | "av1">;
}

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): CloudRenderWorkerConfig {
  const token = required(environment.CLOUD_RENDER_WORKER_TOKEN, "CLOUD_RENDER_WORKER_TOKEN");
  const publicOrigin = httpOrigin(required(environment.CLOUD_RENDER_WORKER_PUBLIC_ORIGIN, "CLOUD_RENDER_WORKER_PUBLIC_ORIGIN"));
  const chromiumPath = resolveChromiumPath(environment.CLOUD_RENDER_CHROMIUM_PATH);
  const gpuMemoryMiB = optionalInteger(environment.CLOUD_RENDER_GPU_MEMORY_MIB, 1, Number.MAX_SAFE_INTEGER);
  return {
    workerId: environment.CLOUD_RENDER_WORKER_ID?.trim() || hostname(),
    host: environment.CLOUD_RENDER_WORKER_HOST?.trim() || "0.0.0.0",
    port: integer(environment.CLOUD_RENDER_WORKER_PORT, 4200, 1, 65_535),
    token,
    publicOrigin,
    chromiumPath,
    headless: environment.CLOUD_RENDER_HEADLESS === "true",
    maxSessions: integer(environment.CLOUD_RENDER_MAX_SESSIONS, 1, 1, 32),
    navigationTimeoutMs: integer(environment.CLOUD_RENDER_NAVIGATION_TIMEOUT_MS, 45_000, 1_000, 120_000),
    canvasTimeoutMs: integer(environment.CLOUD_RENDER_CANVAS_TIMEOUT_MS, 30_000, 1_000, 120_000),
    iceGatheringTimeoutMs: integer(environment.CLOUD_RENDER_ICE_TIMEOUT_MS, 10_000, 1_000, 60_000),
    iceServers: parseIceServers(environment.CLOUD_RENDER_ICE_SERVERS_JSON),
    verifiedHardwareCodecs: parseVerifiedCodecs(environment.CLOUD_RENDER_VERIFIED_HARDWARE_CODECS),
    ...(gpuMemoryMiB ? { gpuMemoryMiB } : {})
  };
}

function parseVerifiedCodecs(value: string | undefined): Array<"h264" | "h265" | "av1"> {
  if (!value?.trim()) return [];
  const codecs = [...new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (!codecs.every((codec) => codec === "h264" || codec === "h265" || codec === "av1")) {
    throw new TypeError("CLOUD_RENDER_VERIFIED_HARDWARE_CODECS 仅支持 h264,h265,av1");
  }
  return codecs as Array<"h264" | "h265" | "av1">;
}

function resolveChromiumPath(configured: string | undefined): string {
  const candidates = [
    configured?.trim(),
    process.platform === "win32" ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" : undefined,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome"
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0] ?? "chromium";
}

function parseIceServers(value: string | undefined): IceServerConfig[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new TypeError("CLOUD_RENDER_ICE_SERVERS_JSON 必须是合法 JSON"); }
  if (!Array.isArray(parsed)) throw new TypeError("CLOUD_RENDER_ICE_SERVERS_JSON 必须是数组");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError(`ICE server ${index} 格式无效`);
    const source = item as Record<string, unknown>;
    const urls = source.urls;
    if (!(typeof urls === "string" || (Array.isArray(urls) && urls.length > 0 && urls.every((url) => typeof url === "string")))) {
      throw new TypeError(`ICE server ${index} 缺少 urls`);
    }
    return {
      urls,
      ...(typeof source.username === "string" ? { username: source.username } : {}),
      ...(typeof source.credential === "string" ? { credential: source.credential } : {})
    };
  });
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${name} 必须配置`);
  return normalized;
}

function httpOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new TypeError("CLOUD_RENDER_WORKER_PUBLIC_ORIGIN 必须是完整 HTTP(S) URL"); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("CLOUD_RENDER_WORKER_PUBLIC_ORIGIN 必须是无路径、凭据、查询和片段的 HTTP(S) origin");
  }
  return parsed.origin;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new TypeError(`配置整数必须位于 ${minimum}-${maximum}`);
  return parsed;
}

function optionalInteger(value: string | undefined, minimum: number, maximum: number): number | undefined {
  if (!value?.trim()) return undefined;
  return integer(value, minimum, minimum, maximum);
}
