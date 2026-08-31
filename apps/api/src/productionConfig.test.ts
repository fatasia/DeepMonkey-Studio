import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { validateProductionConfig } from "./productionConfig.js";

describe("production config", () => {
  it("requires PostgreSQL, MinIO and non-default secrets in production", () => {
    const config = baseConfig();
    expect(() => validateProductionConfig(config, { NODE_ENV: "production" })).toThrow(/METADATA_STORE.*OBJECT_STORE.*SESSION_SECRET/);
  });

  it("accepts the production storage contract", () => {
    const config = baseConfig();
    config.metadata.provider = "postgres";
    config.objects.provider = "minio";
    config.metadata.postgres.password = "postgres-runtime-password";
    config.objects.minio.accessKey = "studio-service-user";
    config.objects.minio.secretKey = "minio-runtime-password";
    expect(() => validateProductionConfig(config, {
      NODE_ENV: "production",
      BIM_STUDIO_ADMIN_PASSWORD: "strong-password",
      BIM_STUDIO_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    })).not.toThrow();
  });

  it("allows only the explicit isolated browser-gate storage override", () => {
    const config = baseConfig();
    config.metadata.postgres.password = "postgres-runtime-password";
    config.objects.minio.accessKey = "studio-service-user";
    config.objects.minio.secretKey = "minio-runtime-password";
    expect(() => validateProductionConfig(config, {
      NODE_ENV: "production",
      BIM_STUDIO_ADMIN_PASSWORD: "strong-password",
      BIM_STUDIO_SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      BIM_STUDIO_E2E_EPHEMERAL: "true",
    })).not.toThrow();
  });

  it("rejects long placeholder values that would otherwise pass length checks", () => {
    const config = baseConfig();
    config.metadata.provider = "postgres";
    config.objects.provider = "minio";
    config.metadata.postgres.password = "change-me-postgres-password";
    config.objects.minio.accessKey = "minioadmin";
    config.objects.minio.secretKey = "change-me-minio-password";
    expect(() => validateProductionConfig(config, {
      NODE_ENV: "production",
      BIM_STUDIO_ADMIN_PASSWORD: "change-me-admin-password",
      BIM_STUDIO_SESSION_SECRET: "replace-with-a-long-random-secret-value",
    })).toThrow(/占位值/);
  });
});

function baseConfig(): AppConfig {
  return {
    port: 4100,
    host: "0.0.0.0",
    webOrigin: "http://localhost:5173",
    dataDir: "data",
    metadata: { provider: "json", postgres: { host: "localhost", port: 5432, database: "bim", user: "postgres", password: "secret", psqlPath: "psql" } },
    objects: { provider: "local", minio: { endpoint: "http://localhost:9000", accessKey: "key", secretKey: "secret", bucket: "bim", alias: "bim", mcPath: "mc" } },
    rvt: { args: [], cwd: "." },
    dwg: { args: [], cwd: "." },
    industrialCad: { args: [], cwd: "." },
    cloudRender: { requestTimeoutMs: 5_000, healthMaxAgeMs: 15_000, mediaEvidenceMaxAgeMs: 15_000 },
    directBindings: { allowPrivateNetwork: false, allowedPorts: [], allowedHostnames: [], requestTimeoutMs: 10_000, maxResponseBytes: 1_024, credentials: {} },
  };
}
