import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiClarificationCard } from "./AiClarificationCard";

/** T1（审计 §二 2.1）：chat 结构化澄清通道的 M4 选项卡载体（服务端 clarification 字段缺省不渲染由消息流保证）。 */
describe("AiClarificationCard（T1 澄清卡 M4 载体）", () => {
  it("渲染澄清问题与选项卡；选项可点（有 onAnswer 时）", () => {
    const html = renderToStaticMarkup(
      <AiClarificationCard locale="zh-CN"
        clarification={{ question: "要统计哪一类构件的工程量？", options: [{ id: "door", label: "门" }, { id: "wall", label: "墙体" }] }}
        onAnswer={vi.fn()} />,
    );
    expect(html).toContain("ai-card ai-card-clarification");
    expect(html).toContain("需要澄清");
    expect(html).toContain("要统计哪一类构件的工程量？");
    expect(html).toContain("2 个选项");
    expect(html).toContain(">门</button>");
    expect(html).toContain(">墙体</button>");
    expect(html).not.toContain("disabled");
  });

  it("无选项时如实引导改述，不伪造选项", () => {
    const html = renderToStaticMarkup(
      <AiClarificationCard locale="zh-CN" clarification={{ question: "请明确时间范围" }} />,
    );
    expect(html).toContain("请明确时间范围");
    expect(html).toContain("请在输入框补充说明后重新发送");
    expect(html).not.toContain("ai-clarification-options");
  });

  it("busy 或缺省 onAnswer 时选项禁用（就地作答不可用但仍可读）", () => {
    const html = renderToStaticMarkup(
      <AiClarificationCard locale="zh-CN"
        clarification={{ question: "问", options: [{ id: "a", label: "甲" }] }} busy />,
    );
    expect(html).toContain("disabled");
    const noHandler = renderToStaticMarkup(
      <AiClarificationCard locale="zh-CN" clarification={{ question: "问", options: [{ id: "a", label: "甲" }] }} />,
    );
    expect(noHandler).toContain("disabled");
  });

  it("footer 保留证据语义行（说明为何先澄清）", () => {
    const html = renderToStaticMarkup(
      <AiClarificationCard locale="zh-CN" clarification={{ question: "问" }} onAnswer={vi.fn()} />,
    );
    expect(html).toContain("ai-card-footer");
    expect(html).toContain("避免基于猜测作答");
  });
});
