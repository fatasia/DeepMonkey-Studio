import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assistantReliabilityFromResponse } from "../ai/assistantReliability";
import { AiResponseEvidence } from "./AiResponseEvidence";

describe("answer context delivery evidence", () => {
  it("carries server receipts into the answer disclosure with original source labels", () => {
    const reliability = assistantReliabilityFromResponse({ reliability: { contextDelivery: {
      unit: "utf16", preparedChars: 100, sentChars: 50, sources: [
        { id: "datasets", path: "platform.data.datasets", status: "partial", preparedChars: 40, sentChars: 20, transformed: false },
        { id: "vision-events", path: "platform.vision.events", status: "omitted", preparedChars: 30, sentChars: 0, transformed: true },
      ],
    } } }, "platform", [
      { id: "datasets", label: "数据集", state: "ready", kind: "snapshot" },
      { id: "vision-events", label: "视觉事件", state: "ready", kind: "snapshot" },
    ]);
    const html = renderToStaticMarkup(<AiResponseEvidence locale="zh-CN" reliability={reliability} />);
    for (const text of ["实际发送来源", "数据集", "部分发送", "20/40", "视觉事件", "未发送", "预处理已裁剪或隔离"]) expect(html).toContain(text);
    expect(html).not.toContain("本次涉及：");
  });

  it("does not interpret missing or invalid receipts as proof of delivery", () => {
    for (const contextDelivery of [undefined, { unit: "utf16", preparedChars: 1, sentChars: 20, sources: [] }]) {
      const reliability = assistantReliabilityFromResponse({ reliability: { contextDelivery } }, "scene", []);
      expect(reliability.contextDelivery).toBeUndefined();
      expect(renderToStaticMarkup(<AiResponseEvidence locale="zh-CN" reliability={reliability} />)).not.toContain("实际发送来源");
    }
  });
});
