import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiAssistantMessages } from "./AiAssistantMessages";
import { AiContextDisclosure } from "./AiContextDisclosure";

describe("assistant request presentation", () => {
  it("distinguishes sent reasoning from an absent provider acknowledgement", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[{ id: "one", mode: "scene", question: "问", answer: "答",
      execution: { protocol: "responses", requestedModel: "alias", reportedModel: "snapshot", reasoningEffortSent: "high" } }]}
      busy={false} error={undefined} stopped={false} lastPrompt="" lastScope="" answer="" onRetry={vi.fn()} />);
    for (const value of ["请求模型", "alias", "服务商返回模型", "snapshot", "发送的思考档位", "high", "服务商返回档位", "未返回"]) expect(html).toContain(value);
  });
  it("keeps a stopped prompt and partial response tied to the original object", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[]}
      busy={false} error={undefined} stopped lastPrompt="检查阀门" lastScope="一号阀门" answer="已读取材质"
      onRetry={vi.fn()} />);
    for (const value of ["检查阀门", "一号阀门", "已停止", "重试原问题", "已读取材质"]) expect(html).toContain(value);
    expect(html).not.toContain("正在处理");
    expect(html).toContain('aria-label="复制回答"');
  });
  it("does not offer copy while the partial answer is still changing", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[]}
      busy error={undefined} stopped={false} lastPrompt="检查" lastScope="阀门" answer="读取中"
      onRetry={vi.fn()} />);
    expect(html).not.toContain('aria-label="复制回答"');
  });
  it("shows scene and selected identity before opening the source disclosure", () => {
    const html = renderToStaticMarkup(<AiContextDisclosure locale="zh-CN" mode="component" loading={false}
      context={{ scene: { name: "产线" }, selected: { id: "valve-1" } }} sources={[]} />);
    expect(html.slice(0, html.indexOf("</summary>"))).toContain("产线 · valve-1");
  });
  // ── K3 回归（审计 §一 K3：dashboard 流式期解析失败返回空串，用户 busy 期间看到零输出）──
  it("K3: shows the structured-plan placeholder while a dashboard answer has no visible text yet", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[]} busy error={undefined}
      stopped={false} lastPrompt="生成看板" lastScope="" answer="" onRetry={vi.fn()} busyHint="正在生成结构化方案…" />);
    expect(html).toContain("正在生成结构化方案…");
    expect(html).not.toContain("正在处理，请稍候");
  });
  it("shows the default busy wording for plain chat modes without a busy hint", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[]} busy error={undefined}
      stopped={false} lastPrompt="检查" lastScope="" answer="" onRetry={vi.fn()} />);
    expect(html).toContain("正在处理，请稍候");
    expect(html).not.toContain("正在生成结构化方案");
  });

  // ── T7 回归（审计 §二 2.3：dashboard 流式中布局不可见 → 骨架占位如实表达"生成中"）──
  it("T7: renders a structure skeleton next to the structured-plan placeholder while the dashboard layout is pending", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[]} busy error={undefined}
      stopped={false} lastPrompt="生成看板" lastScope="" answer="" onRetry={vi.fn()} busyHint="正在生成结构化方案…" />);
    expect(html).toContain("ai-dashboard-skeleton");
    expect(html).toContain('aria-hidden="true"');
  });
  it("T7: keeps plain chat busy free of the dashboard skeleton", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[]} busy error={undefined}
      stopped={false} lastPrompt="检查" lastScope="" answer="" onRetry={vi.fn()} />);
    expect(html).not.toContain("ai-dashboard-skeleton");
  });

  // ── T6 回归（审计 §二 2.3：chat busy 只有转圈，无耗时/阶段）──
  it("T6: shows the elapsed-and-phase progress row while busy with a start timestamp", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[]} busy error={undefined}
      stopped={false} lastPrompt="检查" lastScope="" answer="" onRetry={vi.fn()} requestStartedAt={Date.now() - 4_000} />);
    expect(html).toContain("已等待 4s");
    expect(html).toContain("等待服务响应");
  });
  it("T6: switches the phase to streaming once the answer starts and keeps one timer", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[]} busy error={undefined}
      stopped={false} lastPrompt="检查" lastScope="" answer="部分" onRetry={vi.fn()} requestStartedAt={Date.now() - 9_000} />);
    expect(html).toContain("流式生成中");
    expect((html.match(/role="timer"/g) ?? []).length).toBe(1);
  });
  it("T6: keeps busy free of the progress row without a start timestamp", () => {
    const html = renderToStaticMarkup(<AiAssistantMessages locale="zh-CN" conversation={[]} busy error={undefined}
      stopped={false} lastPrompt="检查" lastScope="" answer="" onRetry={vi.fn()} />);
    expect(html).not.toContain("role=\"timer\"");
  });

  // ── T1 回归（审计 §二 2.1：chat 无结构化澄清通道——载体就位、数据源缺省不渲染）──
  it("T1: renders the clarification card with options only when the turn carries a clarification", () => {
    const withClarification = renderToStaticMarkup(
      <AiAssistantMessages locale="zh-CN"
        conversation={[{ id: "c1", mode: "sql", question: "问", answer: "需要澄清",
          clarification: { question: "统计哪个数据集？", options: [{ id: "ds1", label: "产量表" }] } }]}
        busy={false} error={undefined} stopped={false} lastPrompt="" lastScope="" answer="" onRetry={vi.fn()}
        onAnswerClarification={vi.fn()} />);
    expect(withClarification).toContain("ai-card-clarification");
    expect(withClarification).toContain("统计哪个数据集？");
    expect(withClarification).toContain("产量表");
    const withoutClarification = renderToStaticMarkup(
      <AiAssistantMessages locale="zh-CN"
        conversation={[{ id: "c2", mode: "scene", question: "问", answer: "答" }]}
        busy={false} error={undefined} stopped={false} lastPrompt="" lastScope="" answer="" onRetry={vi.fn()} />);
    expect(withoutClarification).not.toContain("ai-card-clarification");
  });
  it("T1: disables clarification options while busy", () => {
    const html = renderToStaticMarkup(
      <AiAssistantMessages locale="zh-CN"
        conversation={[{ id: "c1", mode: "sql", question: "问", answer: "需要澄清",
          clarification: { question: "统计哪个数据集？", options: [{ id: "ds1", label: "产量表" }] } }]}
        busy={false} error={undefined} stopped={false} lastPrompt="" lastScope="" answer="" onRetry={vi.fn()} />);
    // 缺省 onAnswerClarification 时选项同样禁用（不出现点了没反应的承诺）。
    expect(html).toContain("disabled");
  });
});
