import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import path from "node:path";
import { loadConfig } from "./config.js";
import { validateProductionConfig } from "./productionConfig.js";

export async function runProductionPreflight(): Promise<void> {
  const config = loadConfig();
  validateProductionConfig(config, { ...process.env, NODE_ENV: "production" });
  const issues: string[] = [];

  if (!commandAvailable(config.metadata.postgres.psqlPath, ["--version"])) issues.push("psql 客户端不可执行");
  if (!commandAvailable(config.objects.minio.mcPath, ["--version"])) issues.push("MinIO mc 客户端不可执行");
  if (!(await canConnect(config.metadata.postgres.host, config.metadata.postgres.port))) {
    issues.push(`PostgreSQL ${config.metadata.postgres.host}:${config.metadata.postgres.port} 不可达`);
  } else if (!postgresAccessible(config)) {
    issues.push("PostgreSQL 凭据或目标数据库不可用");
  }
  if (!(await minioHealthy(config.objects.minio.endpoint))) {
    issues.push(`MinIO ${config.objects.minio.endpoint} 健康检查失败`);
  } else if (!minioAccessible(config)) {
    issues.push("MinIO 凭据或目标 Bucket 不可用");
  }
  if (issues.length > 0) throw new Error(issues.join("；"));
}

function postgresAccessible(config: ReturnType<typeof loadConfig>): boolean {
  const postgres = config.metadata.postgres;
  const result = spawnSync(postgres.psqlPath, [
    "-X", "-v", "ON_ERROR_STOP=1",
    "-h", postgres.host,
    "-p", String(postgres.port),
    "-U", postgres.user,
    "-d", postgres.database,
    "-t", "-A", "-c", "SELECT 1",
  ], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 8_000,
    env: { ...process.env, PGPASSWORD: postgres.password },
  });
  return result.status === 0;
}

function minioAccessible(config: ReturnType<typeof loadConfig>): boolean {
  const minio = config.objects.minio;
  const endpoint = new URL(minio.endpoint);
  endpoint.username = minio.accessKey;
  endpoint.password = minio.secretKey;
  const alias = "bimpreflight";
  const environment = {
    ...process.env,
    [`MC_HOST_${alias}`]: endpoint.toString(),
    MC_CONFIG_DIR: path.join(config.dataDir, "mc-preflight-config"),
  };
  const target = `${alias}/${minio.bucket}`;
  if (!runMc(minio.mcPath, ["stat", "--quiet", target], environment)) return false;
  const probe = `${target}/.health/preflight-${process.pid}-${Date.now()}`;
  const written = runMc(minio.mcPath, ["pipe", probe], environment, "industrial-studio-preflight");
  const readable = written && runMc(minio.mcPath, ["stat", "--quiet", probe], environment);
  const removed = runMc(minio.mcPath, ["rm", "--force", probe], environment);
  return Boolean(written && readable && removed);
}

function runMc(command: string, args: string[], environment: NodeJS.ProcessEnv, input?: string): boolean {
  const result = spawnSync(command, args, {
    windowsHide: true,
    stdio: input === undefined ? "ignore" : ["pipe", "ignore", "ignore"],
    timeout: 8_000,
    env: environment,
    ...(input === undefined ? {} : { input }),
  });
  return result.status === 0;
}

function commandAvailable(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { windowsHide: true, stdio: "ignore", timeout: 5_000 });
  return result.status === 0;
}

function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (value: boolean) => { socket.destroy(); resolve(value); };
    socket.setTimeout(2_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function minioHealthy(endpoint: string): Promise<boolean> {
  try {
    const url = new URL("/minio/health/live", endpoint);
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

runProductionPreflight()
  .then(() => process.stdout.write("生产配置、PostgreSQL 与 MinIO 预检通过。\n"))
  .catch((error: unknown) => {
    process.stderr.write(`生产预检失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
