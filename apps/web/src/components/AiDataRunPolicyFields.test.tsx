import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiDataRunPolicyFields } from "./AiDataRunPolicyFields";

describe("AiDataRunPolicyFields", () => {
  it("keeps the primary run mode simple and advanced quality controls discoverable", () => {
    const html = renderToStaticMarkup(
      <AiDataRunPolicyFields
        value={{
          mode: "interval", intervalSeconds: 60, windowRows: 120, minimumSamples: 30,
          maxAgeSeconds: 300, maximumMissingRate: 0.2, entityField: "deviceId", timeField: "timestamp",
        }}
        fields={[{ key: "deviceId", label: "设备" }, { key: "timestamp", label: "时间" }]}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("自动周期运行");
    expect(html).toContain("高级策略");
    expect(html).toContain("最大数据延迟");
    expect(html).toContain("允许缺失率");
  });
});
