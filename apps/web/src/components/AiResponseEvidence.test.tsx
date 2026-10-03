import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { assistantReliabilityFromResponse } from "../ai/assistantReliability";
import { AiResponseEvidence } from "./AiResponseEvidence";

/**
 * T5（H-C5-T5 逐条引用与真正证据锚对齐 20261003）回归锁：
 * 证据面板必须把回答数值对应到服务端给出的真实证据锚（来源标签+偏移+可复制指纹）；
 * 前端不自造锚，服务端无锚时整节缺省。
 */
describe("answer per-item citation anchors", () => {
  it("renders server citations as token-to-source rows with copyable fingerprints", () => {
    const fingerprint = "a".repeat(64);
    const reliability = assistantReliabilityFromResponse({ reliability: {
      traceId: "trace-1", verification: "unverified", contextTrust: "server-evidence",
      evidenceCount: 0, inputRisk: "low", writePolicy: "read-only", warnings: [],
      contextDelivery: { unit: "utf16", preparedChars: 100, sentChars: 100, sources: [
        { id: "datasets", path: "platform.data.datasets", status: "sent", preparedChars: 60, sentChars: 60, transformed: false },
      ] },
      citations: [
        { token: "EQ-2205", anchors: [
          { sourceId: "datasets", sourcePath: "platform.data.datasets", offset: 42, fingerprint },
          { sourceId: "bim-evidence", sourcePath: "bimEvidence", offset: 7, fingerprint: "b".repeat(64) },
        ] },
      ],
    } }, "scene", [{ id: "datasets", label: "数据集", state: "ready", kind: "snapshot" }]);
    const html = renderToStaticMarkup(<AiResponseEvidence locale="zh-CN" reliability={reliability} />);
    expect(html).toContain("逐条引用");
    expect(html).toContain("EQ-2205");
    expect(html).toContain("数据集");
    // 无用户标签的来源按既有族回退：bim-evidence → BIM 证据。
    expect(html).toContain("BIM 证据");
    expect(html).toContain("@42");
    expect(html).toContain("@7");
    expect(html).toContain(fingerprint);
    // 可复制行与 T4 同族：按钮带 aria-label。
    expect(html).toContain("复制来源指纹（数据集）");
    // 合法 HTML：引用锚内不出现 dd（复制钮为裸按钮）。
    expect(html).not.toMatch(/<span class="citation-anchor[^"]*"><dd>/);
  });

  it("keeps the panel free of citation machinery when the server sent none", () => {
    const reliability = assistantReliabilityFromResponse({ reliability: {
      traceId: "trace-1", verification: "unverified", contextTrust: "client-snapshot",
      evidenceCount: 0, inputRisk: "low", writePolicy: "read-only", warnings: [],
    } }, "scene", []);
    const html = renderToStaticMarkup(<AiResponseEvidence locale="zh-CN" reliability={reliability} />);
    expect(html).not.toContain("逐条引用");
  });
});
