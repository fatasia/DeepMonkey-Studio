import type { DataConnectionRecord } from "@bim-studio/contracts";

export function safeSimulationConfig(config: DataConnectionRecord["config"]): DataConnectionRecord["config"] {
  try {
    const source = new URL(String(config.url));
    if (source.protocol !== "sim:") return {};
    const url = new URL(`sim://${source.hostname || "telemetry"}`);
    for (const key of ["rows", "seed", "interval", "start"]) if (source.searchParams.has(key)) url.searchParams.set(key, source.searchParams.get(key)!);
    return { url: url.toString() };
  } catch { return {}; }
}

/** 直接绑定包含连接参数，保留其字段/目标但导入后显式重新配置，绝不把凭据带进交付文件。 */
export function sanitizeTransferContent<T>(source: T): T {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).flatMap(([key, child]) => {
      if (/^(?:password|passwordEnv|token|accessToken|refreshToken|apiKey|secret|credential|authorization|headers|directBinding)$/i.test(key)) return [];
      return [[key, key === "enabled" && record.directBinding ? false : typeof child === "string" && /(?:url|src)$/i.test(key) ? sanitizeTransferUrl(child) : visit(child)]];
    }));
  };
  return visit(source) as T;
}

export function sanitizeTransferUrl(value: string): string {
  try {
    const url = new URL(value, "https://transfer.invalid");
    if (!["http:", "https:"].includes(url.protocol)) return value;
    url.username = ""; url.password = "";
    for (const key of [...url.searchParams.keys()]) if (/token|secret|key|credential|signature|authorization|x-amz-/i.test(key)) url.searchParams.delete(key);
    return value.startsWith("/") ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch { return value; }
}

