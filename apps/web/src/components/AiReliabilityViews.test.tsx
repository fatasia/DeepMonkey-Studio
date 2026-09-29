import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiContextDisclosure } from "./AiContextDisclosure";
import { AiResponseEvidence } from "./AiResponseEvidence";

describe("AI reliability views", () => {
  it("discloses object identity and states that a client snapshot is not execution evidence", () => {
    const html = renderToStaticMarkup(
      <AiContextDisclosure
        locale="zh-CN"
        mode="component"
        context={{
          project: { id: "p1", name: "电池工厂" },
          scene: { id: "s1", name: "一号产线" },
          selected: { id: "robot-1", name: "焊接机器人", kind: "model" },
          script: { id: "script-1", name: "联锁脚本", language: "typescript" },
          simulation: { studyId: "study-1", name: "黄金矩阵", status: "passed" },
        }}
        sources={[{ id: "scene", label: "当前三维场景快照", state: "ready", kind: "snapshot", count: 1 }]}
        loading={false}
      />,
    );

    expect(html).toContain("焊接机器人");
    expect(html).toContain("联锁脚本");
    expect(html).toContain("黄金矩阵");
    expect(html).toContain("快照只是模型输入");
    expect(html).toContain("Capability 结果才是已执行事实");
  });

  it("shows traceable Capability evidence separately from write policy", () => {
    const html = renderToStaticMarkup(
      <AiResponseEvidence
        locale="zh-CN"
        reliability={{
          grade: "capability-verified",
          contextTrust: "capability-result",
          traceId: "trace-9",
          contextFingerprint: "sha256:evidence",
          evidenceCount: 3,
          inputRisk: "low",
          writePolicy: "read-only",
          warnings: [],
          sourceLabels: ["设备温度"],
        }}
      />,
    );

    expect(html).toContain("Capability 已执行");
    expect(html).toContain("trace-9");
    expect(html).toContain("只读");
    expect(html).toContain("输入风险");
    expect(html).toContain("3 条");
  });

  // ── T4 回归（审计 §二 2.2：traceId/证据指纹仅 title 纯文本，不可操作）──
  it("T4: renders trace id and evidence fingerprint as structured copy actions with full text in title", () => {
    const html = renderToStaticMarkup(
      <AiResponseEvidence
        locale="zh-CN"
        reliability={{
          grade: "capability-verified",
          contextTrust: "capability-result",
          traceId: "trace-abc123",
          contextFingerprint: "sha256:fingerprint-xyz",
          evidenceCount: 2,
          inputRisk: "low",
          writePolicy: "read-only",
          warnings: [],
          sourceLabels: [],
        }}
      />,
    );
    expect(html).toContain('aria-label="复制Trace ID"');
    expect(html).toContain('aria-label="复制证据指纹"');
    expect(html).toContain('title="trace-abc123"');
    expect(html).toContain('title="sha256:fingerprint-xyz"');
    expect(html).toContain("ai-evidence-copy");
    // 未点击前不显示"已复制"反馈（sr-only 状态位初始为空）。
    expect(html).not.toContain(">已复制<");
  });

  it("T4: omits the copy rows entirely when the reliability has no trace or fingerprint", () => {
    const html = renderToStaticMarkup(
      <AiResponseEvidence
        locale="zh-CN"
        reliability={{
          grade: "unverified",
          contextTrust: "client-snapshot",
          evidenceCount: 0,
          inputRisk: "low",
          writePolicy: "read-only",
          warnings: [],
          sourceLabels: [],
        }}
      />,
    );
    expect(html).not.toContain("复制Trace ID");
    expect(html).not.toContain("复制证据指纹");
  });
});
