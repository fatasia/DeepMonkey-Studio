import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnvironment } from "dotenv";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
loadEnvironment({ path: path.join(projectRoot, ".env"), quiet: true });

function parseArgs(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // The startup validation below provides a useful, deterministic fallback.
  }
  return fallback;
}

export interface CommandProviderConfig {
  command?: string;
  args: string[];
  cwd: string;
}

export interface AppConfig {
  port: number;
  host: string;
  webOrigin: string;
  dataDir: string;
  metadata: {
    provider: "json" | "postgres";
    postgres: {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      psqlPath: string;
    };
  };
  objects: {
    provider: "local" | "minio";
    minio: {
      endpoint: string;
      accessKey: string;
      secretKey: string;
      bucket: string;
      alias: string;
      mcPath: string;
    };
  };
  rvt: CommandProviderConfig;
  dwg: CommandProviderConfig;
  cloudRender: {
    workerUrl?: string;
    workerToken?: string;
    publicOrigin?: string;
    requestTimeoutMs: number;
    healthMaxAgeMs: number;
    mediaEvidenceMaxAgeMs: number;
  };
  directBindings: {
    allowPrivateNetwork: boolean;
    allowedPorts: number[];
    allowedHostnames: string[];
    requestTimeoutMs: number;
    maxResponseBytes: number;
    credentials: Record<string, Record<string, string>>;
  };
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.cwd(), process.env.DATA_DIR)
    : path.join(projectRoot, "data");
  const rvtCommand = process.env.RVT_CONVERTER_COMMAND?.trim();
  const bundledDwgCommand = path.join(projectRoot, "tools", "libredwg", process.platform === "win32" ? "dwg2dxf.exe" : "dwg2dxf");
  const dwgCommand = process.env.DWG_CONVERTER_COMMAND?.trim()
    || (existsSync(bundledDwgCommand) ? bundledDwgCommand : undefined);
  const cloudRenderWorkerUrl = process.env.CLOUD_RENDER_WORKER_URL?.trim();
  const cloudRenderWorkerToken = process.env.CLOUD_RENDER_WORKER_TOKEN?.trim();
  const cloudRenderPublicOrigin = process.env.CLOUD_RENDER_PUBLIC_ORIGIN?.trim();
  return {
    port: Number(process.env.API_PORT ?? 4100),
    host: process.env.API_HOST ?? "0.0.0.0",
    webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
    dataDir,
    metadata: {
      provider: process.env.METADATA_STORE === "postgres" ? "postgres" : "json",
      postgres: {
        host: process.env.POSTGRES_HOST ?? "127.0.0.1",
        port: Number(process.env.POSTGRES_PORT ?? 5432),
        database: process.env.POSTGRES_DATABASE ?? "bim_studio",
        user: process.env.POSTGRES_USER ?? "postgres",
        password: process.env.POSTGRES_PASSWORD ?? "",
        psqlPath: process.env.POSTGRES_PSQL_PATH ?? "psql"
      }
    },
    objects: {
      provider: process.env.OBJECT_STORE === "minio" ? "minio" : "local",
      minio: {
        endpoint: process.env.MINIO_ENDPOINT ?? "http://127.0.0.1:9000",
        accessKey: process.env.MINIO_ACCESS_KEY ?? "",
        secretKey: process.env.MINIO_SECRET_KEY ?? "",
        bucket: process.env.MINIO_BUCKET ?? "bim-studio",
        alias: process.env.MINIO_ALIAS ?? "bim-local",
        mcPath: process.env.MINIO_MC_PATH ?? "mc"
      }
    },
    rvt: {
      ...(rvtCommand ? { command: rvtCommand } : {}),
      args: parseArgs(process.env.RVT_CONVERTER_ARGS, ["--input", "{input}", "--output", "{output}", "--mode", "{mode}"]),
      cwd: projectRoot
    },
    dwg: {
      ...(dwgCommand ? { command: dwgCommand } : {}),
      args: parseArgs(process.env.DWG_CONVERTER_ARGS, ["-y", "-o", "{output}/model.dxf", "{input}"]),
      cwd: projectRoot
    },
    cloudRender: {
      ...(cloudRenderWorkerUrl ? { workerUrl: cloudRenderWorkerUrl } : {}),
      ...(cloudRenderWorkerToken ? { workerToken: cloudRenderWorkerToken } : {}),
      ...(cloudRenderPublicOrigin ? { publicOrigin: cloudRenderPublicOrigin } : {}),
      requestTimeoutMs: boundedNumber(process.env.CLOUD_RENDER_REQUEST_TIMEOUT_MS, 5_000, 250, 30_000),
      healthMaxAgeMs: boundedNumber(process.env.CLOUD_RENDER_HEALTH_MAX_AGE_MS, 15_000, 1_000, 120_000),
      mediaEvidenceMaxAgeMs: boundedNumber(process.env.CLOUD_RENDER_MEDIA_MAX_AGE_MS, 15_000, 1_000, 120_000)
    },
    directBindings: {
      allowPrivateNetwork: process.env.DIRECT_BINDING_ALLOW_PRIVATE_NETWORK === "true",
      allowedPorts: parseNumberList(process.env.DIRECT_BINDING_ALLOWED_PORTS, [80, 443]),
      allowedHostnames: parseStringList(process.env.DIRECT_BINDING_ALLOWED_HOSTNAMES),
      requestTimeoutMs: boundedNumber(process.env.DIRECT_BINDING_TIMEOUT_MS, 10_000, 250, 120_000),
      maxResponseBytes: boundedNumber(process.env.DIRECT_BINDING_MAX_RESPONSE_BYTES, 2 * 1024 * 1024, 1_024, 32 * 1024 * 1024),
      credentials: parseCredentialHeaders(process.env.DIRECT_BINDING_CREDENTIALS_JSON)
    }
  };
}

function parseStringList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function parseNumberList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const parsed = parseStringList(value).map(Number);
  return parsed.length > 0 && parsed.every((item) => Number.isInteger(item) && item >= 1 && item <= 65_535) ? parsed : fallback;
}

function parseCredentialHeaders(value: string | undefined): Record<string, Record<string, string>> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed).filter(([, headers]) => headers && typeof headers === "object" && !Array.isArray(headers));
    if (!entries.every(([, headers]) => Object.values(headers as Record<string, unknown>).every((header) => typeof header === "string"))) return {};
    return Object.fromEntries(entries) as Record<string, Record<string, string>>;
  } catch {
    return {};
  }
}

function boundedNumber(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
}
