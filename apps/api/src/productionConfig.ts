import type { AppConfig } from "./config.js";

/** 生产进程禁止静默回退到单机 JSON/本地目录，避免上线后形成不可迁移的数据孤岛。 */
export function validateProductionConfig(config: AppConfig, environment: NodeJS.ProcessEnv = process.env): void {
  if (environment.NODE_ENV !== "production") return;
  const issues: string[] = [];
  // 浏览器发布门禁使用隔离的临时目录，显式开关只允许跳过存储后端检查；
  // 真实生产进程仍必须使用 PostgreSQL + MinIO，密码和会话密钥检查不会跳过。
  const ephemeralStorage = environment.BIM_STUDIO_E2E_EPHEMERAL === "true";
  if (!ephemeralStorage && config.metadata.provider !== "postgres") issues.push("METADATA_STORE 必须为 postgres");
  if (!ephemeralStorage && config.objects.provider !== "minio") issues.push("OBJECT_STORE 必须为 minio");
  if (weakSecret(config.metadata.postgres.password)) issues.push("POSTGRES_PASSWORD 未配置或仍为占位值");
  if (weakSecret(config.objects.minio.accessKey) || weakSecret(config.objects.minio.secretKey)) issues.push("MinIO 访问凭据未配置或仍为占位值");
  if ((environment.BIM_STUDIO_ADMIN_PASSWORD?.length ?? 0) < 12 || weakSecret(environment.BIM_STUDIO_ADMIN_PASSWORD)) {
    issues.push("BIM_STUDIO_ADMIN_PASSWORD 至少 12 位且不能使用占位值");
  }
  if ((environment.BIM_STUDIO_SESSION_SECRET?.length ?? 0) < 32 || weakSecret(environment.BIM_STUDIO_SESSION_SECRET)) {
    issues.push("BIM_STUDIO_SESSION_SECRET 至少 32 位且不能使用占位值");
  }
  if (issues.length > 0) throw new Error(`生产配置检查失败：${issues.join("；")}`);
}

function weakSecret(value: string | undefined): boolean {
  if (!value) return true;
  return /^(?:admin|minioadmin|password|secret|change-me|replace-with)/i.test(value.trim());
}
