import { describe, expect, it } from "vitest";
import { assertDataWritebackConfig, validateDataWritebackValues, type DataWritebackConfig } from "./dataWriteback.js";
const config: DataWritebackConfig = { version: 1, recordPath: "/records/{id}", fields: [{ key: "产量", type: "number", required: true, min: 0, max: 100 }, { key: "date", type: "date" }, { key: "status", type: "string", options: ["open", "closed"] }] };
describe("REST 填报合同", () => {
  it("接受明确字段与合法值，不把空字符串数值化", () => {
    expect(() => assertDataWritebackConfig(config)).not.toThrow();
    expect(validateDataWritebackValues(config, { 产量: 5, date: "2024-02-29", status: "open" })).toEqual([]);
    expect(validateDataWritebackValues(config, { 产量: "" })).toEqual([{ field: "产量", message: "不能为空" }]);
  });
  it.each([null, [], {}, { ...config, recordPath: "//evil.test/{id}" }, { ...config, recordPath: "/../{id}" }, { ...config, recordPath: "/{id}/{id}" }, { ...config, fields: [{ key: "__proto__", type: "string" }] }, { ...config, fields: [{ key: "x", type: "number", min: 5, max: 1 }] }])("拒绝无效或越界配置 %j", value => expect(() => assertDataWritebackConfig(value)).toThrow());
  it("返回所有字段错误并拒绝未允许字段", () => {
    expect(validateDataWritebackValues(config, { 产量: 101, date: "2026-02-30", status: "unknown", admin: true }).map(issue => issue.field)).toEqual(["admin", "产量", "date", "status"]);
    expect(validateDataWritebackValues(config, null)).toHaveLength(1);
    expect(validateDataWritebackValues(config, {})).toHaveLength(2);
  });
});

describe("PostgreSQL 填报目标合同", () => {
  const sql = { version: 2, kind: "postgresql", schema: "public", table: "records", primaryKey: "id", versionColumn: "revision", fields: [{ key: "output", type: "number" }] };
  it("接受SQL配置但不改变REST旧配置", () => {
    expect(() => assertDataWritebackConfig(sql)).not.toThrow();
    expect(() => assertDataWritebackConfig(config)).not.toThrow();
  });
  it.each([
    { ...sql, table: "records;DROP TABLE records" }, { ...sql, schema: "pg_catalog" }, { ...sql, schema: "information_schema" },
    { ...sql, table: 'records"' }, { ...sql, primaryKey: "revision" }, { ...sql, table: "a".repeat(64) },
    { ...sql, table: "中".repeat(22) }, { ...sql, kind: "mysql" }, { ...sql, query: "UPDATE records" },
    { ...sql, fields: [{ key: "id", type: "string" }] }, { ...sql, fields: [{ key: "revision", type: "number" }] },
    { ...sql, fields: [{ key: "__revision", type: "number" }] },
  ])("拒绝越权/歧义标识符 %j", value => expect(() => assertDataWritebackConfig(value)).toThrow());
});
