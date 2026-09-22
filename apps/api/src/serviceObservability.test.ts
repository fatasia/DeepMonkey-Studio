import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonStore } from "./jsonStore.js";
import {
  collectServiceHealth,
  createDiagnosticArchive,
  createDiagnosticSnapshot,
  normalizeServiceLogFilters,
  queryServiceLogs,
  redactServiceLog,
} from "./serviceObservability.js";
import { registerSystemRoutes } from "./system.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("service observability", () => {
  it("waits for response audit writes before closing the API", async () => {
    const dataDir = await temporaryDataDirectory();
    const store = new JsonStore(dataDir);
    await store.init();
    const app = Fastify();
    await registerSystemRoutes(app, store, dataDir);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const persist = store.addAuditLog.bind(store);
    const audit = vi.spyOn(store, "addAuditLog").mockImplementation(async (record) => {
      await pending;
      await persist(record);
    });
    await app.inject({ method: "GET", url: "/api/admin/health" });
    expect(audit).toHaveBeenCalledOnce();
    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
    } finally {
      release();
      await closing;
      await Promise.all(audit.mock.results.map((result) => result.value));
    }
    const restored = new JsonStore(dataDir);
    await restored.init();
    expect(restored.listAuditLogs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: "/api/admin/health", statusCode: 401 }),
    ]));
  });
  it("removes terminal colors before redaction, including JSON escaped colors", () => {
    expect(redactServiceLog("\u001b[2m09:50:53\u001b[22m \u001b[36m[vite]\u001b[0m ready")).toBe("09:50:53 [vite] ready");
    expect(redactServiceLog("pass\u001b[31mword=private\u001b[0m")).toBe("password=[REDACTED]");
    expect(redactServiceLog(JSON.stringify({ msg: "\u001b[31merror\u001b[0m" }))).toBe('{"msg":"error"}');
    expect(redactServiceLog("array[2] and [31m ordinary text")).toBe("array[2] and [31m ordinary text");
  });
  it("filters structured and plain service logs while removing credentials", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "fixture.out.log"), [
      JSON.stringify({ level: 30, time: "2026-09-03T09:00:00.000Z", msg: "server ready" }),
      JSON.stringify({ level: 50, time: "2026-09-03T10:00:00.000Z", msg: "request failed", authorization: "Bearer raw-secret" }),
      "2026-09-03T11:00:00.000Z WARN reconnect password=plain-secret",
    ].join("\n"), "utf8");

    const result = await queryServiceLogs([directory], normalizeServiceLogFilters({
      service: "fixture",
      level: "error",
      from: "2026-09-03T09:30:00.000Z",
      keyword: "failed",
      limit: "50",
    }));

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ service: "fixture", level: "error", timestamp: "2026-09-03T10:00:00.000Z" });
    expect(result.items[0]?.message).toContain("[REDACTED]");
    expect(result.items[0]?.message).not.toContain("raw-secret");
    expect(redactServiceLog("password=hunter2 Bearer abc.def.ghi https://u:p@example.test")).toBe("password=[REDACTED] Bearer [REDACTED] https://[REDACTED]@example.test");
  });

  it("uses explicit not-configured storage states instead of fake health", async () => {
    vi.stubEnv("METADATA_STORE", "json");
    vi.stubEnv("OBJECT_STORE", "local");
    vi.stubEnv("WEB_ORIGIN", "http://127.0.0.1:1");
    const health = await collectServiceHealth();
    expect(health.find((item) => item.id === "api")).toMatchObject({ status: "healthy" });
    expect(health.find((item) => item.id === "api")?.latencyMs).toBeGreaterThan(0);
    expect(health.find((item) => item.id === "postgres")).toMatchObject({ status: "not-configured" });
    expect(health.find((item) => item.id === "minio")).toMatchObject({ status: "not-configured" });
    expect(health.find((item) => item.id === "media")).toMatchObject({ status: "not-configured", endpoint: "未配置" });
    expect(health.find((item) => item.id === "web")).toMatchObject({ status: "offline" });
  });

  it("keeps an explicitly configured media gateway failure visible", async () => {
    vi.stubEnv("METADATA_STORE", "json");
    vi.stubEnv("OBJECT_STORE", "local");
    vi.stubEnv("WEB_ORIGIN", "http://127.0.0.1:1");
    vi.stubEnv("MEDIA_GATEWAY_CONTROL_URL", "http://127.0.0.1:1");
    const health = await collectServiceHealth();
    expect(health.find((item) => item.id === "media")).toMatchObject({
      status: "offline",
      endpoint: "http://127.0.0.1:1/",
    });
  });

  it("recognizes the current DeepMonkey Web shell as healthy", async () => {
    vi.stubEnv("METADATA_STORE", "json");
    vi.stubEnv("OBJECT_STORE", "local");
    vi.stubEnv("WEB_ORIGIN", "http://studio.test");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      "<!doctype html><html><head><title>DeepMonkey Studio</title></head><body><div id=\"root\"></div></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    )));
    const health = await collectServiceHealth();
    expect(health.find((item) => item.id === "web")).toMatchObject({
      status: "healthy",
      endpoint: "http://studio.test/",
      message: "页面标识验证通过",
    });
  });

  it("builds a credential-free diagnostic archive", async () => {
    vi.stubEnv("METADATA_STORE", "json");
    vi.stubEnv("OBJECT_STORE", "local");
    vi.stubEnv("WEB_ORIGIN", "http://127.0.0.1:1");
    const dataDir = await temporaryDataDirectory();
    await writeFile(path.join(dataDir, "logs", "fixture.err.log"), "ERROR apiKey=archive-secret\n", "utf8");
    const snapshot = await createDiagnosticSnapshot(dataDir);
    const bytes = await createDiagnosticArchive(snapshot);
    const archive = await JSZip.loadAsync(bytes);
    const diagnostic = await archive.file("diagnostic.json")?.async("string");
    const readme = await archive.file("README.txt")?.async("string");
    expect(diagnostic).toContain("[REDACTED]");
    expect(diagnostic).not.toContain("archive-secret");
    expect(readme).toContain("不包含凭据");
  });

  it("exposes authenticated filters, health, export and diagnostic download routes", async () => {
    vi.stubEnv("METADATA_STORE", "json");
    vi.stubEnv("OBJECT_STORE", "local");
    vi.stubEnv("WEB_ORIGIN", "http://127.0.0.1:1");
    const dataDir = await temporaryDataDirectory();
    await writeFile(path.join(dataDir, "logs", "route.err.log"), "2026-09-03T10:00:00.000Z ERROR token=route-secret\n", "utf8");
    const store = new JsonStore(dataDir);
    await store.init();
    const app = Fastify();
    await registerSystemRoutes(app, store, dataDir);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
    const authorization = `Bearer ${login.json().token}`;

    const logs = await app.inject({ method: "GET", url: "/api/admin/service-logs?service=route&level=error&keyword=ERROR", headers: { authorization } });
    expect(logs.statusCode).toBe(200);
    expect(logs.json()).toMatchObject({ total: 1, items: [{ service: "route", level: "error" }] });
    expect(logs.body).not.toContain("route-secret");

    const invalid = await app.inject({ method: "GET", url: "/api/admin/service-logs?level=fatal", headers: { authorization } });
    expect(invalid.statusCode).toBe(400);
    const health = await app.inject({ method: "GET", url: "/api/admin/health", headers: { authorization } });
    expect(health.json().find((item: { id: string }) => item.id === "postgres")).toMatchObject({ status: "not-configured" });

    const exported = await app.inject({ method: "GET", url: "/api/admin/service-logs/export?service=route", headers: { authorization } });
    expect(exported.headers["content-disposition"]).toContain("bim-studio-service-logs-");
    expect(exported.body).toContain("[REDACTED]");
    const bundle = await app.inject({ method: "GET", url: "/api/admin/diagnostics/download", headers: { authorization } });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers["content-type"]).toContain("application/zip");
    await app.close();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-studio-observability-"));
  directories.push(directory);
  return directory;
}

async function temporaryDataDirectory(): Promise<string> {
  const directory = await temporaryDirectory();
  await mkdir(path.join(directory, "logs"), { recursive: true });
  return directory;
}
