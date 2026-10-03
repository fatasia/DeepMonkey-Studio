import { describe, expect, it } from "vitest";
import { buildSampleConnectionDraft, buildSampleDatasetDraft } from "./dataCenterSampleData";

describe("KWeaver 式内置样例装载:草稿构建合同", () => {
  it("连接草稿:http 指向内置演示端点,幂等键=固定名", () => {
    const draft = buildSampleConnectionDraft("内置演示数据");
    expect(draft.name).toBe("内置演示数据");
    expect(draft.type).toBe("http");
    expect(draft.enabled).toBe(true);
    expect(draft.config).toMatchObject({ url: "/api/demo/sensors", format: "json" });
    // 同名再调草稿逐字一致(幂等的键面)。
    expect(buildSampleConnectionDraft("内置演示数据")).toEqual(draft);
  });

  it("数据集草稿:字段与后端 demo 表列逐一对应,refresh 15s", () => {
    const draft = buildSampleDatasetDraft("conn-1", "设备遥测演示");
    expect(draft.connectionId).toBe("conn-1");
    expect(draft.name).toBe("设备遥测演示");
    expect(draft.sourceKey).toBe("/api/demo/sensors");
    expect(draft.refreshSeconds).toBe(15);
    expect(draft.fields.map(field => field.key)).toEqual(["recorded_at", "device_id", "temperature", "pressure", "running"]);
    expect(draft.fields.every(field => Boolean(field.label))).toBe(true);
  });
});
