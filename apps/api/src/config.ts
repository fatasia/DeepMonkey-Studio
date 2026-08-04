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
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.cwd(), process.env.DATA_DIR)
    : path.join(projectRoot, "data");
  const rvtCommand = process.env.RVT_CONVERTER_COMMAND?.trim();
  const bundledDwgCommand = path.join(projectRoot, "tools", "libredwg", process.platform === "win32" ? "dwg2dxf.exe" : "dwg2dxf");
  const dwgCommand = process.env.DWG_CONVERTER_COMMAND?.trim()
    || (existsSync(bundledDwgCommand) ? bundledDwgCommand : undefined);
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
    }
  };
}
