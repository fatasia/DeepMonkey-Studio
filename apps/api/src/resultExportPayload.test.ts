import { describe, expect, it } from "vitest";
import type { StudyReport } from "@bim-studio/contracts";
import { assertMqttPublishTopic, assertResultExportTarget, assertSqlTableName } from "@bim-studio/contracts";
import {
  STUDY_RESULTS_DEFAULT_TABLE,
  buildResultExportPayload,
  resultExportPayloadSha256,
} from "./resultExport.js";

function reportFixture(): StudyReport {
  return {
    meta: {
      studyId: "study-1",
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      seed: 42,
      replications: 5,
      generatedAt: "2026-09-26T00:00:00.000Z",
      inputFingerprint: "input-sha-1",
      resultFingerprint: "result-sha-1",
    },
    headline: "吞吐 118-126 件/h",
    model: { nodeCount: 6, resourceCount: 4 },
    kpis: [
      { key: "throughput", label: "平均产出", value: 122, unit: "/h", ci95: { lower95: 118, upper95: 126, samples: 5 }, provenance: "measured" },
      { key: "average-wip", label: "平均在制品", value: 8.4, provenance: "measured" },
    ],
    bottlenecks: [],
    energy: {
      activeEnergyKwh: { key: "active-energy", label: "激活能耗", value: 12.5, unit: "kWh", provenance: "measured" },
      idleEnergyKwh: { key: "idle-energy", label: "空转能耗", value: 3.5, unit: "kWh", provenance: "measured" },
      totalEnergyKwh: { key: "total-energy", label: "总能耗", value: 16, unit: "kWh", provenance: "measured" },
      energyPerCompletedItemKwh: { key: "unit-energy", label: "单位能耗", value: 0.013, unit: "kWh/件", provenance: "measured" },
      electricityCost: { key: "cost", label: "电费", value: 12.8, unit: "元", provenance: "measured" },
      electricityCostPerCompletedItem: { key: "unit-cost", label: "单位电费", value: 0.0104, unit: "元/件", provenance: "measured" },
      carbonEmissionKg: { key: "carbon", label: "碳排", value: 9.2, unit: "kgCO₂e", provenance: "measured" },
      carbonEmissionPerCompletedItemKg: { key: "unit-carbon", label: "单位碳排", value: 0.0075, unit: "kgCO₂e/件", provenance: "measured" },
      peakDemandKw: { key: "peak", label: "峰值功率", value: 20, unit: "kW", provenance: "measured" },
      consumerEnergyKwh: [{ consumerId: "W1", energyKwh: { key: "w1", label: "W1 能耗", value: 7, unit: "kWh", provenance: "measured" } }],
    },
    orders: [
      {
        orderId: "PO-1",
        completionRate: { key: "cr", label: "完成率", value: 100, unit: "%", provenance: "measured" },
        onTimeFulfillmentRate: { key: "ot", label: "准交率", value: 95, unit: "%", ci95: { lower95: 90, upper95: 100, samples: 5 }, provenance: "measured" },
        fullyCompletedRate: { key: "fc", label: "整单完成率", value: 90, unit: "%", provenance: "measured" },
        observedTardinessMinutes: { key: "tard", label: "拖期", value: 2, unit: "min", provenance: "measured" },
      },
    ],
    lineage: { baselineStudyId: null, reproductionOf: null },
    limitations: [],
    provenance: "measured",
  };
}

describe("buildResultExportPayload", () => {
  it("从 StudyReport 组装 KPI 与行,指纹透传,行表缺省 study_results", () => {
    const payload = buildResultExportPayload(reportFixture());
    expect(payload.payloadJson.studyId).toBe("study-1");
    expect(payload.payloadJson.fingerprints).toEqual({ input: "input-sha-1", result: "result-sha-1" });
    const keys = payload.rows.map((row) => row.values[1]);
    expect(keys).toContain("throughput");
    expect(keys).toContain("energy.active-energy-kwh");
    expect(keys).toContain("energy.consumer.W1");
    expect(keys).toContain("order.PO-1.completion-rate");
    // 分节不重复导出主 KPI 表已收录的语义(energy-total / order-<id>-on-time)。
    expect(keys).not.toContain("energy.total-energy-kwh");
    expect(keys).not.toContain("order.PO-1.on-time-fulfillment-rate");
    expect(new Set(keys).size).toBe(keys.length);
    for (const row of payload.rows) expect(row.table).toBe(STUDY_RESULTS_DEFAULT_TABLE);
    const throughput = payload.rows.find((row) => row.values[1] === "throughput")!.values;
    expect(throughput[2]).toBe(122);
    expect(throughput[4]).toBe(118);
    expect(throughput[5]).toBe(126);
    expect(throughput[6]).toBe(5);
    expect(throughput[7]).toBe("measured");
    expect(throughput[8]).toBe("result-sha-1");
    const wip = payload.rows.find((row) => row.values[1] === "average-wip")!.values;
    expect(wip[4]).toBeNull();
    expect(wip[6]).toBeNull();
  });

  it("includeFingerprints=false 时 payload 去指纹、行 fingerprint 为 null,sha256 随之变化", () => {
    const full = buildResultExportPayload(reportFixture());
    const bare = buildResultExportPayload(reportFixture(), { includeFingerprints: false });
    expect(bare.payloadJson.fingerprints).toBeUndefined();
    expect(JSON.stringify(bare.payloadJson)).not.toContain("input-sha-1");
    expect(bare.rows.every((row) => row.values[8] === null)).toBe(true);
    expect(resultExportPayloadSha256(bare.payloadJson)).not.toBe(resultExportPayloadSha256(full.payloadJson));
  });

  it("payload sha256 对同输入稳定、对异输入不同", () => {
    const first = buildResultExportPayload(reportFixture());
    const second = buildResultExportPayload(reportFixture());
    expect(resultExportPayloadSha256(first.payloadJson)).toBe(resultExportPayloadSha256(second.payloadJson));
    expect(resultExportPayloadSha256(first.payloadJson)).toMatch(/^[0-9a-f]{64}$/);
    const changed = reportFixture();
    changed.kpis[0].value = 123;
    expect(resultExportPayloadSha256(buildResultExportPayload(changed).payloadJson))
      .not.toBe(resultExportPayloadSha256(first.payloadJson));
  });

  it("非法表名在组装时拒绝", () => {
    expect(() => buildResultExportPayload(reportFixture(), { table: "study; drop table x" })).toThrow(/标识符/);
    expect(() => buildResultExportPayload(reportFixture(), { table: "1abc" })).toThrow(/标识符/);
  });
});

describe("resultExport 合同校验", () => {
  const validMqtt = { kind: "mqtt", topicOrTable: "factory/des/study-1", format: "json", includeFingerprints: true };
  const validSql = { kind: "sql", topicOrTable: "study_results", format: "rows", includeFingerprints: true };

  it("合法目标通过", () => {
    expect(() => assertResultExportTarget(validMqtt)).not.toThrow();
    expect(() => assertResultExportTarget({ ...validSql, topicOrTable: "ops.study_results" })).not.toThrow();
  });

  it("kind/format 不匹配拒绝", () => {
    expect(() => assertResultExportTarget({ ...validMqtt, format: "rows" })).toThrow(/json/);
    expect(() => assertResultExportTarget({ ...validSql, format: "json" })).toThrow(/rows/);
    expect(() => assertResultExportTarget({ ...validMqtt, kind: "kafka" })).toThrow(/kind/);
    expect(() => assertResultExportTarget({ ...validSql, includeFingerprints: "yes" })).toThrow(/布尔/);
  });

  it("MQTT 发布主题拒绝通配符、$ 前缀、NUL 与空串", () => {
    expect(() => assertMqttPublishTopic("a/+/b")).toThrow(/通配符/);
    expect(() => assertMqttPublishTopic("a/#")).toThrow(/通配符/);
    expect(() => assertMqttPublishTopic("$sys/x")).toThrow(/\$/);
    expect(() => assertMqttPublishTopic("a\u0000b")).toThrow(/NUL/);
    expect(() => assertMqttPublishTopic("")).toThrow(/非空/);
    expect(() => assertResultExportTarget({ ...validMqtt, topicOrTable: "a/+/b" })).toThrow(/通配符/);
  });

  it("SQL 表名拒绝注入与非法标识符", () => {
    expect(() => assertSqlTableName("study; drop table x")).toThrow(/标识符/);
    expect(() => assertSqlTableName("study--x")).toThrow(/标识符/);
    expect(() => assertSqlTableName("")).toThrow(/非空/);
    expect(() => assertResultExportTarget({ ...validSql, topicOrTable: "x; drop table y" })).toThrow(/标识符/);
  });
});
