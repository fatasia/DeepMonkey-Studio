import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord, DataPostgresWritebackConfig } from "@bim-studio/contracts";
import { createIsolatedPostgres } from "../scripts/isolatedPostgresFixture.mjs";
import { DataPostgresWritebackService } from "./dataPostgresWritebackService.js";
import { createApiServer } from "./serverOptions.js";
import { registerDataWritebackRoutes } from "./dataWritebackRoutes.js";
import { loadConfig } from "./config.js";
import type { MetadataStore } from "./store.js";

const service = new DataPostgresWritebackService();
const target: DataPostgresWritebackConfig = { version: 2, kind: "postgresql", schema: "public", table: "records", primaryKey: "id", versionColumn: "revision", fields: [{ key: "output", type: "number", min: 0, max: 100 }, { key: "note", type: "string" }, { key: "due", type: "date" }, { key: "active", type: "boolean" }] };
let fixture: Awaited<ReturnType<typeof createIsolatedPostgres>>, connection: DataConnectionRecord;
const dataset: DataDatasetRecord = { id: "rows", projectId: "p", connectionId: "pg", name: "SQL", refreshSeconds: 0, fields: [], createdAt: "now", updatedAt: "now", writeback: target };
beforeAll(async () => {
  fixture = await createIsolatedPostgres();
  vi.stubEnv("BIM_WRITEBACK_PG_PASSWORD", "");
  connection = { id: "pg", projectId: "p", type: "postgresql", name: "PG", enabled: true, config: { ...fixture.connection, password: undefined, port: fixture.proxyPort, passwordEnv: "BIM_WRITEBACK_PG_PASSWORD" }, createdAt: "now", updatedAt: "now" };
  await fixture.client.query("CREATE TABLE records (id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 1, output integer CHECK(output <= 90), note text, due date, active boolean)");
}, 60000);
afterAll(async () => { await fixture?.close(); vi.unstubAllEnvs(); }, 30000);
async function seed(id: string) { await fixture.client.query("INSERT INTO records(id,output,note,due,active) VALUES($1,7,'old','2026-09-08',true)", [id]); }
const request = (version = '"sql:1"', values: Record<string, unknown> = { output: 12 }) => ({ expectedVersion: version, values });

describe("真实隔离 PostgreSQL 单记录填报", () => {
  it("参数化更新、服务端版本递增、日期布尔读回；SQL片段仅作字符串值", async () => {
    await seed("one");
    expect(await service.read(connection, dataset, "one")).toMatchObject({ version: '"sql:1"', values: { output: 7, due: "2026-09-08", active: true } });
    const note = "x'); DROP TABLE records; --";
    expect(await service.write(connection, dataset, "one", request('"sql:1"', { output: 12, note, active: false, due: "2026-10-01" }))).toMatchObject({ version: '"sql:2"', values: { output: 12, note, active: false, due: "2026-10-01" } });
    expect((await fixture.client.query("SELECT * FROM records WHERE id=$1", ["one"])).rows[0]).toMatchObject({ output: 12, revision: "2", note });
    await expect(service.write(connection, dataset, "one", request())).rejects.toMatchObject({ statusCode: 409, outcome: "not-written" });
  });
  it("并发相同版本恰一成功，数据库约束失败不递增版本", async () => {
    await seed("race");
    const results = await Promise.allSettled([service.write(connection, dataset, "race", request()), service.write(connection, dataset, "race", request())]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(results.find(item => item.status === "rejected")).toMatchObject({ reason: { statusCode: 409 } });
    await expect(service.write(connection, dataset, "race", request('"sql:2"', { output: 95 }))).rejects.toMatchObject({ statusCode: 422, outcome: "not-written" });
    expect(await service.read(connection, dataset, "race")).toMatchObject({ version: '"sql:2"', values: { output: 12 } });
  });
  it("COMMIT回执断线是真实已写未确认；显式读回不重放", async () => {
    await seed("unknown"); fixture.dropNextCommit();
    await expect(service.write(connection, dataset, "unknown", request())).rejects.toMatchObject({ statusCode: 502, outcome: "unknown", code: "write-outcome-unknown" });
    expect(fixture.droppedCommits()).toBe(1);
    expect(await service.read(connection, dataset, "unknown")).toMatchObject({ version: '"sql:2"', values: { output: 12 } });
    await expect(service.write(connection, dataset, "unknown", request())).rejects.toMatchObject({ statusCode: 409 });
  });
  it("拒绝假主键、可空版本、列类型不匹配；未找到为404", async () => {
    await fixture.client.query("CREATE TABLE invalid (id text, revision bigint, output integer); INSERT INTO invalid VALUES ('a',1,1),('a',1,2)");
    const bad = { ...dataset, writeback: { ...target, table: "invalid", fields: [{ key: "output", type: "number" as const }] } };
    await expect(service.write(connection, bad, "a", request())).rejects.toMatchObject({ code: "primary-key-required" });
    await fixture.client.query("CREATE TABLE nullable (id text PRIMARY KEY, revision bigint, output integer)");
    await expect(service.read(connection, { ...bad, writeback: { ...bad.writeback, table: "nullable" } }, "a")).rejects.toMatchObject({ code: "version-column-required" });
    await expect(service.read(connection, { ...dataset, writeback: { ...target, fields: [{ key: "output", type: "string" }] } }, "one")).rejects.toMatchObject({ code: "column-type-mismatch" });
    await expect(service.read(connection, dataset, "missing")).rejects.toMatchObject({ statusCode: 404 });
  });
  it("禁止跨项目、非法标识符/值/临时SQL和缺失凭据，不回退平台库", async () => {
    await expect(service.read({ ...connection, projectId: "other" }, dataset, "one")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.read(connection, { ...dataset, writeback: { ...target, table: "records;DROP TABLE records" } }, "one")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.read(connection, dataset, "one' OR 1=1--")).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.write(connection, dataset, "one", { ...request(), sql: "UPDATE records SET output=1" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(service.write(connection, dataset, "one", request('"sql:2"', { output: 101 }))).rejects.toMatchObject({ statusCode: 422 });
    await expect(service.write(connection, dataset, "one", request('"sql:2"', { revision: 9 }))).rejects.toMatchObject({ statusCode: 422 });
    await expect(service.read({ ...connection, config: { ...connection.config, passwordEnv: "BIM_WRITEBACK_MISSING_PASSWORD" } }, dataset, "one")).rejects.toMatchObject({ code: "invalid-credential" });
  });
  it("真实SQL路由复用401/跨项目/viewer权限，editor可写且返回既有合同", async () => {
    await seed("route");
    const app = createApiServer(); let role: "admin" | "editor" | "viewer" | undefined, projects = ["p"];
    app.addHook("preHandler", async req => { if (role) req.systemUser = { id: "test", username: "test", displayName: "test", role, projectIds: projects, enabled: true, createdAt: "now", updatedAt: "now" }; });
    await registerDataWritebackRoutes(app, { listDatasets: () => [dataset], listDataConnections: () => [connection] } as unknown as MetadataStore, loadConfig());
    const url = "/api/projects/p/datasets/rows/records/route";
    try {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      role = "viewer";
      expect((await app.inject({ method: "GET", url })).json().values.output).toBe(7);
      expect((await app.inject({ method: "PATCH", url, payload: request() })).statusCode).toBe(403);
      role = "editor"; projects = ["other"];
      expect((await app.inject({ method: "PATCH", url, payload: request() })).statusCode).toBe(403);
      projects = ["p"];
      expect((await app.inject({ method: "PATCH", url, payload: request() })).json()).toMatchObject({ version: '"sql:2"', values: { output: 12 } });
      const conflict = await app.inject({ method: "PATCH", url, payload: request() });
      expect(conflict.statusCode).toBe(409); expect(conflict.json()).toMatchObject({ code: "revision-conflict", outcome: "not-written", retryable: false });
    } finally { await app.close(); }
  });
  it("真实数据库账号无UPDATE权限拒写；版本生成异常整笔回滚", async () => {
    await seed("restricted");
    await fixture.client.query("CREATE ROLE only_read LOGIN; GRANT SELECT ON records TO only_read");
    await expect(service.write({ ...connection, config: { ...connection.config, user: "only_read" } }, dataset, "restricted", request())).rejects.toMatchObject({ statusCode: 403, outcome: "not-written" });
    await fixture.client.query("CREATE FUNCTION keep_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.revision := OLD.revision; RETURN NEW; END $$; CREATE TRIGGER keep_revision BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION keep_revision()");
    try {
      await expect(service.write(connection, dataset, "restricted", request())).rejects.toMatchObject({ code: "version-update-invalid", outcome: "not-written" });
      expect(await service.read(connection, dataset, "restricted")).toMatchObject({ version: '"sql:1"', values: { output: 7 } });
    } finally { await fixture.client.query("DROP TRIGGER keep_revision ON records; DROP FUNCTION keep_revision()"); }
  });
  it("numeric无法往返的精度明确拒绝，等价小数尾零保持可用", async () => {
    await fixture.client.query("CREATE TABLE precise (id text PRIMARY KEY, revision integer NOT NULL, output numeric); INSERT INTO precise VALUES ('safe',1,1.230000),('tiny',1,0.123456789012345678901),('large',1,9007199254740993)");
    const precise = { ...dataset, writeback: { ...target, table: "precise", fields: [{ key: "output", type: "number" as const }] } };
    expect(await service.read(connection, precise, "safe")).toMatchObject({ values: { output: 1.23 } });
    await expect(service.read(connection, precise, "tiny")).rejects.toMatchObject({ code: "invalid-record" });
    await expect(service.read(connection, precise, "large")).rejects.toMatchObject({ code: "invalid-record" });
  });
});
