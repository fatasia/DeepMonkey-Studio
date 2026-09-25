import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiAssistantComposer } from "./AiAssistantComposer";

describe("AiAssistantComposer", () => {
  it("shows why send is unavailable while shared context is restoring", () => {
    const html = renderToStaticMarkup(<AiAssistantComposer locale="zh-CN" question="保留的草稿" busy={false}
      sendDisabled disabledReason="正在恢复会话，请稍候" onChange={vi.fn()} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(html).toContain("保留的草稿");
    expect(html).toContain('title="正在恢复会话，请稍候"');
    expect(html).toContain("disabled");
  });
});
