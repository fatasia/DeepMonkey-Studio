import { createHash } from "node:crypto";

export type AiModelCatalogCategory = "auth" | "network" | "unsupported" | "server" | "invalid";

export type AiModelCatalogResult =
  | { ok: true; models: string[]; cachedAt?: string }
  | { ok: false; category: AiModelCatalogCategory; message: string };

interface CatalogCacheEntry { at: string; models: string[] }

const CACHE_TTL_MS = 5 * 60 * 1_000;
const cache = new Map<string, CatalogCacheEntry>();
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MODELS = 500;

/**
 * 拉取 OpenAI 兼容服务的模型列表（GET /models）。
 * 失败分档：鉴权（401/403）、不支持（404/405/501，服务没有模型目录端点）、
 * 网络（连接失败/超时）、服务端（5xx）。密钥只用于本次请求，绝不返回或记录。
 */
export async function fetchProviderModels(input: { baseUrl: string; apiKey: string; refresh?: boolean }): Promise<AiModelCatalogResult> {
  const baseUrl = input.baseUrl.replace(/\/$/, "");
  if (!baseUrl || !input.apiKey) return { ok: false, category: "invalid", message: "请先配置 Base URL 和 API Key 再拉取模型列表" };
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { return { ok: false, category: "invalid", message: "Base URL 无效" }; }
  if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, category: "invalid", message: "Base URL 只能使用 HTTP(S) 地址" };

  const cacheKey = catalogCacheKey(baseUrl, input.apiKey);
  const cached = cache.get(cacheKey);
  if (!input.refresh && cached && Date.now() - Date.parse(cached.at) < CACHE_TTL_MS) {
    return { ok: true, models: [...cached.models], cachedAt: cached.at };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("拉取模型列表超时")), REQUEST_TIMEOUT_MS);
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${input.apiKey}` },
      signal: controller.signal,
    });
    if (response.ok) {
      try { body = await response.json(); }
      catch (error) { if (controller.signal.aborted) throw error; }
    }
  } catch (error) {
    return {
      ok: false,
      category: "network",
      message: controller.signal.aborted ? "拉取模型列表超时，请检查服务可达性" : `无法连接模型服务：${safeMessage(error)}`,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) return { ok: false, category: "auth", message: "模型服务拒绝访问（HTTP 401/403），请检查 API Key" };
    if ([404, 405, 501].includes(response.status)) return { ok: false, category: "unsupported", message: "该服务未提供模型列表端点（/models），请手动填写模型名" };
    if (response.status >= 500) return { ok: false, category: "server", message: `模型服务错误（HTTP ${response.status}），请稍后重试` };
    return { ok: false, category: "invalid", message: `模型列表请求失败（HTTP ${response.status}）` };
  }

  const models = normalizeModels(body);
  if (!models.length) return { ok: false, category: "unsupported", message: "模型服务返回了无法识别的列表格式，请手动填写模型名" };
  cache.set(cacheKey, { at: new Date().toISOString(), models });
  return { ok: true, models };
}

function normalizeModels(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const payload = body as { data?: unknown; models?: unknown };
  const raw: unknown[] = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  const models = raw
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const model = item as { id?: unknown; name?: unknown };
      return typeof model.id === "string" ? model.id.trim() : typeof model.name === "string" ? model.name.trim() : "";
    })
    .filter((id) => id.length > 0 && id.length <= 256)
    .sort((left, right) => left.localeCompare(right));
  return [...new Set(models)].slice(0, MAX_MODELS);
}

function catalogCacheKey(baseUrl: string, apiKey: string): string {
  // 密钥只参与哈希，不进入缓存键明文或日志。
  return `${baseUrl}#${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}`;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(?:bearer\s+|api[_ -]?key[=:]\s*)[^\s,;]+/gi, "[REDACTED]").slice(0, 200);
}

export function clearModelCatalogCacheForTests(): void {
  cache.clear();
}
