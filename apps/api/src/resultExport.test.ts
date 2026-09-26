import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ResultExportTarget } from "@bim-studio/contracts";
import {
  MemoryMqttTransport,
  MemoryStudyResultSqlTransport,
  publishResultMqtt,
  resolveMqttTransport,
  resolvePgTransport,
  writeResultSql,
} from "./resultExport.js";
import type { ResultExportPayload, ResultExportPayloadJson } from "./resultExport.js";

const mqttTarget: ResultExportTarget = { kind: "mqtt", topicOrTable: "factory/des/study-1", format: "json", includeFingerprints: true };
const sqlTarget: ResultExportTarget = { kind: "sql", topicOrTable: "study_results", format: "rows", includeFingerprints: true };

function payloadFixture(studyId = "study-1"): ResultExportPayload {
  const payloadJson: ResultExportPayloadJson = {
    schemaVersion: 1,
    studyId,
    engine: { engineId: "plant-lite-des", engineVersion: "1.0.0" },
    seed: 42,
    replications: 5,
    provenance: "measured",
    lineage: { baselineStudyId: null, reproductionOf: null },
    fingerprints: { input: "in-1", result: "res-1" },
    kpis: [
      { key: "throughput", label: "吞吐", value: 122, unit: "/h", provenance: "measured" },
      { key: "average-wip", label: "WIP", value: 8.4, provenance: "measured" },
      { key: "lead-time", label: "交付周期", value: 12, provenance: "measured" },
    ],
  };
  return {
    payloadJson,
    rows: payloadJson.kpis.map((kpi) => ({
      table: "study_results",
      values: [payloadJson.studyId, kpi.key, kpi.value, kpi.unit ?? null, null, null, null, kpi.provenance, "res-1"],
    })),
  };
}

describe("publishResultMqtt(fake transport)", () => {
  it("单主题 JSON 发布 QoS 1,收据携带 payload sha256 并调用 end", async () => {
    const transport = new MemoryMqttTransport();
    const payload = payloadFixture();
    const receipt = await publishResultMqtt(payload, mqttTarget, transport);
    expect(transport.publications).toHaveLength(1);
    expect(transport.publications[0].topic).toBe("factory/des/study-1");
    expect(transport.publications[0].qos).toBe(1);
    expect(transport.ended).toBe(true);
    expect(receipt.transport).toBe("fake");
    expect(receipt.itemCount).toBe(3);
    expect(receipt.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const expectedSha = createHash("sha256").update(transport.publications[0].payload).digest("hex");
    expect(receipt.evidence.payloadSha256).toBe(expectedSha);
    expect(JSON.parse(transport.publications[0].payload).studyId).toBe("study-1");
  });

  it("目标类型不匹配或缺 transport/连接时显式报错", async () => {
    const payload = payloadFixture();
    await expect(publishResultMqtt(payload, sqlTarget, new MemoryMqttTransport())).rejects.toThrow(/MQTT 目标/);
    await expect(publishResultMqtt(payload, mqttTarget)).rejects.toThrow(/broker 连接配置/);
  });

  it("依赖缺失时显式报未安装而非 crash", async () => {
    const brokenLoad = () => Promise.reject(new Error("Cannot find module 'mqtt'"));
    await expect(resolveMqttTransport({ brokerUrl: "mqtt://broker:1883" }, brokenLoad)).rejects.toThrow(/mqtt 客户端未安装/);
    await expect(resolveMqttTransport({ brokerUrl: "mqtt://broker:1883" }, async () => ({}))).rejects.toThrow(/connectAsync/);
  });
});

describe("writeResultSql(fake transport)", () => {
  it("写入后按主键回读全部行,语句参数化且无值拼接", async () => {
    const transport = new MemoryStudyResultSqlTransport();
    const receipt = await writeResultSql(payloadFixture(), sqlTarget, transport);
    expect(receipt.transport).toBe("fake");
    expect(receipt.itemCount).toBe(3);
    const rows = transport.readRows("study_results");
    expect(rows.map((row) => row[1])).toEqual(["average-wip", "lead-time", "throughput"]);
    expect(rows.find((row) => row[1] === "throughput")![2]).toBe(122);
    const upserts = transport.statements.filter((statement) => statement.text.startsWith("INSERT INTO"));
    expect(upserts).toHaveLength(3);
    for (const statement of upserts) {
      expect(statement.text).toContain("ON CONFLICT (study_id, metric_key, provenance) DO UPDATE");
      expect(statement.text).toContain("$9");
      expect(statement.values).toHaveLength(9);
      expect(statement.text).not.toContain("122");
    }
    expect(transport.ensuredTables).toEqual(["study_results"]);
    expect(receipt.evidence.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("重复写同一 Study 不产生重复行(幂等),值被 UPSERT 覆盖", async () => {
    const transport = new MemoryStudyResultSqlTransport();
    await writeResultSql(payloadFixture(), sqlTarget, transport);
    await writeResultSql(payloadFixture(), sqlTarget, transport);
    expect(transport.readRows("study_results")).toHaveLength(3);
    const updated = payloadFixture();
    updated.payloadJson.kpis[0].value = 130;
    updated.rows[0].values[2] = 130;
    await writeResultSql(updated, sqlTarget, transport);
    const rows = transport.readRows("study_results");
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row[1] === "throughput")![2]).toBe(130);
  });

  it("不同 studyId 追加新行;行表不一致与目标不匹配拒绝", async () => {
    const transport = new MemoryStudyResultSqlTransport();
    await writeResultSql(payloadFixture(), sqlTarget, transport);
    await writeResultSql(payloadFixture("study-2"), sqlTarget, transport);
    expect(transport.readRows("study_results")).toHaveLength(6);
    const foreign = payloadFixture();
    foreign.rows = foreign.rows.map((row) => ({ ...row, table: "other_table" }));
    await expect(writeResultSql(foreign, sqlTarget, transport)).rejects.toThrow(/不一致/);
    await expect(writeResultSql(payloadFixture(), mqttTarget, transport)).rejects.toThrow(/SQL 目标/);
    await expect(writeResultSql(payloadFixture(), sqlTarget)).rejects.toThrow(/数据库连接配置/);
  });

  it("依赖缺失时显式报未安装", async () => {
    const brokenLoad = () => Promise.reject(new Error("Cannot find module 'pg'"));
    await expect(resolvePgTransport({}, brokenLoad)).rejects.toThrow(/pg 客户端未安装/);
    await expect(resolvePgTransport({}, async () => ({}))).rejects.toThrow(/Client/);
  });
});
