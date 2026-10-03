import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { useAssistantSessions } from "../ai/useAssistantSessions";
import { AiAssistantSessionControls, AiAssistantSessionPicker } from "./AiAssistantSessionControls";

const noop = () => undefined;
const noopAsync = async () => undefined;

function sessions(overrides: Partial<ReturnType<typeof useAssistantSessions>> = {}): ReturnType<typeof useAssistantSessions> {
  return {
    identity: "[]", sessions: [], sessionId: "", conversation: [], setConversation: noop, loading: false,
    error: "", cursor: undefined, conflict: false, externalSessionId: undefined,
    select: noopAsync, refresh: noopAsync, newSession: noop, begin: async () => undefined, retrySave: noopAsync,
    ...overrides,
  } as ReturnType<typeof useAssistantSessions>;
}

describe("AiAssistantSessionControls（K12 多标签页同步语义行）", () => {
  it("renders the cross-tab conflict banner with a one-click refresh instead of a bare error line", () => {
    const html = renderToStaticMarkup(
      <AiAssistantSessionControls locale="zh-CN" sessions={sessions({ conflict: true })} disabled={false} onSwitch={noop} />,
    );
    expect(html).toContain("另一个标签页已更新了此会话");
    expect(html).toContain("刷新获取最新状态");
    expect(html).toContain('role="alert"');
    // 冲突不是普通保存失败：不出现"重试保存"（重试只会再次 409）。
    expect(html).not.toContain("重试保存");
  });

  it("keeps plain save failures on the retryable error line without the conflict banner", () => {
    const html = renderToStaticMarkup(
      <AiAssistantSessionControls locale="zh-CN" sessions={sessions({ error: "会话保存失败：offline" })} disabled={false} onSwitch={noop} />,
    );
    expect(html).toContain("会话保存失败：offline");
    expect(html).toContain("重试保存");
    expect(html).not.toContain("另一个标签页已更新");
  });

  it("offers to load the latest conversation when another window reports a write", () => {
    const html = renderToStaticMarkup(
      <AiAssistantSessionControls locale="zh-CN" sessions={sessions({ externalSessionId: "s1" })} disabled={false} onSwitch={noop} />,
    );
    expect(html).toContain("另一个窗口更新了此会话");
    expect(html).toContain("载入最新");
    expect(html).toContain('role="status"');
  });

  it("renders neither sync banner in the normal single-tab state", () => {
    const html = renderToStaticMarkup(
      <AiAssistantSessionControls locale="zh-CN" sessions={sessions()} disabled={false} onSwitch={noop} />,
    );
    expect(html).not.toContain("另一个标签页已更新");
    expect(html).not.toContain("另一个窗口更新了此会话");
    // 正常态不占空间：没有需要处理的事项时整块不渲染。
    expect(html).toBe("");
  });
});

describe("AiAssistantSessionPicker", () => {
  it("folds pagination into the dropdown and disables 'new' when already on a new conversation", () => {
    const html = renderToStaticMarkup(
      <AiAssistantSessionPicker locale="zh-CN" disabled={false} onSwitch={noop}
        sessions={sessions({ sessions: [{ id: "s1", title: "产线巡检" }] as never, cursor: "c2" })} />,
    );
    expect(html).toContain("产线巡检");
    expect(html).toContain("更多会话…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="新会话"/);
  });

  it("shows the restore state inside the dropdown instead of a separate status line", () => {
    const html = renderToStaticMarkup(
      <AiAssistantSessionPicker locale="zh-CN" disabled={false} onSwitch={noop} sessions={sessions({ loading: true })} />,
    );
    expect(html).toContain("正在恢复会话…");
    expect(html).toMatch(/<select[^>]*disabled=""/);
  });
});
