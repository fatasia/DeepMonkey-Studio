import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { useAssistantSessions } from "../ai/useAssistantSessions";
import { AiAssistantSessionControls } from "./AiAssistantSessionControls";

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
  });
});
