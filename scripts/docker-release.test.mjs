import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "../..");

test("application Compose uses the existing stores, persistent application data, and required secrets", () => {
  const secret = "local-contract-test-credential-0123456789";
  const config = spawnSync("docker", ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.app.yml",
    "config", "--format", "json"], { cwd: root, encoding: "utf8", windowsHide: true,
    env: { ...process.env, POSTGRES_PASSWORD: secret, MINIO_ROOT_USER: secret, MINIO_ROOT_PASSWORD: secret,
      BIM_STUDIO_ADMIN_PASSWORD: secret, BIM_STUDIO_SESSION_SECRET: secret,
      STUDIO_VERSION: "0.2.0", STUDIO_PORT: "14100", STUDIO_PUBLIC_ORIGIN: "http://localhost:14100",
      BIM_STUDIO_MINIO_IMAGE: "deep-monkey-minio:2025.5.24" } });
  assert.equal(config.status, 0, config.stderr);
  const parsed = JSON.parse(config.stdout), studio = parsed.services.studio;
  assert.deepEqual(Object.keys(parsed.services).sort(), ["minio", "postgres", "studio"]);
  assert.equal(studio.image, "deep-monkey-studio:0.2.0");
  assert.equal(parsed.services.minio.image, "deep-monkey-minio:2025.5.24");
  assert.equal(studio.read_only, true);
  assert.equal(studio.init, true);
  assert.equal(studio.depends_on.postgres.condition, "service_healthy");
  assert.equal(studio.depends_on.minio.condition, "service_healthy");
  const postgres = parsed.services.postgres;
  assert.ok(postgres.healthcheck.test[1].includes("$${POSTGRES_DB}"), "Health check must use the database variable provided to the image");
  assert.ok(postgres.environment.POSTGRES_DB);
  assert.equal(studio.environment.POSTGRES_HOST, "postgres");
  assert.equal(studio.environment.POSTGRES_PORT, "5432");
  assert.equal(studio.environment.MINIO_ENDPOINT, "http://minio:9000");
  assert.equal(studio.environment.METADATA_STORE, "postgres");
  assert.equal(studio.environment.OBJECT_STORE, "minio");
  assert.equal(studio.environment.WEB_ORIGIN, "http://localhost:14100");
  assert.equal(studio.ports[0].published, "14100");
  assert.ok(studio.volumes.some(volume => volume.target === "/var/lib/studio" && volume.type === "volume"));
});

test("Docker context keeps WASM source bins while excluding local state and install trees", async () => {
  const ignored = await readFile(resolve(root, ".dockerignore"), "utf8");
  for (const rule of [".env*", ".git", "data", "artifacts", "**/node_modules", "**/target", "**/dist"])
    assert.ok(ignored.split(/\r?\n/).includes(rule));
  assert.ok(!ignored.split(/\r?\n/).includes("**/bin"), "Native src/bin participates in the WASM source fingerprint");
  assert.ok(!ignored.includes("engine-wasm"), "The release WASM bundle must be included in the build context");
  const file = await readFile(resolve(root, "Dockerfile"), "utf8");
  assert.ok(file.includes("node scripts/check-runtime-artifact-freshness.mjs"));
  assert.ok(file.includes("postgresql-client"));
  assert.ok(file.includes("/usr/local/bin/mc"));
  assert.ok(file.includes("USER node"));
  assert.ok(file.includes("ENV ONNXRUNTIME_NODE_INSTALL=skip"), "CPU image must not download optional CUDA binaries");
  assert.ok(file.includes("cp -a apps/api/dist/. /out/apps/api/dist/"), "Deploy must copy dist contents without nesting dist twice");
});
