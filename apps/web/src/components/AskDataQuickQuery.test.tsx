import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AskDataQuickQuery, buildQuickAskDataPlan } from "./AskDataQuickQuery";

// 静态信息架构测试不初始化依赖 window 的真实 API 客户端。
vi.mock("../api", () => ({ api: { invokeCapability: vi.fn() } }));

const dataset = {
  id: "telemetry", projectId: "project", connectionId: "sim", name: "设备遥测", refreshSeconds: 10,
  fields: [{ key: "device", label: "设备", type: "string" as const }, { key: "temperature", label: "温度", type: "number" as const, unit: "°C" }],
  createdAt: "now", updatedAt: "now",
};

describe("AskDataQuickQuery", () => {
  it("builds a constrained aggregate plan without SQL", () => {
    expect(buildQuickAskDataPlan(dataset, "temperature", "device", "avg")).toMatchObject({
      datasetId: "telemetry", fields: ["device", "temperature"], groupBy: ["device"],
      aggregations: [{ operator: "avg", field: "temperature", as: "avg_temperature" }], limit: 20,
    });
  });

  it("renders the zero-learning query controls", () => {
    const html = renderToStaticMarkup(<AskDataQuickQuery projectId="project" datasets={[dataset]} locale="zh-CN" />);
    expect(html).toContain("零 SQL 快速统计");
    expect(html).toContain("设备遥测");
    expect(html).toContain("直接统计");
  });
});
