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
});
