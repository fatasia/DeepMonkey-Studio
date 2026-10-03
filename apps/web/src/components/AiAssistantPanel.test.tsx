import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ api: {} }));

// K6：会话由 stub 控制，便于在组件级锁死"历史窗口裁剪披露"接线。
// 形状覆盖渲染路径读取的字段（AiAssistantSessionControls 读 sessions/sid）。
const sessionsStub = vi.hoisted(() => ({
  identity: "identity-test",
  sessions: [] as Array<Record<string, unknown>>,
  sessionId: "",
  conversation: [] as Array<Record<string, unknown>>,
  setConversation: (value: unknown) => value,
  loading: false,
  error: undefined as string | undefined,
  cursor: undefined as string | undefined,
  conflict: false,
  externalSessionId: undefined as string | undefined,
  select: () => undefined,
  refresh: () => undefined,
  newSession: () => undefined,
  begin: async () => undefined,
  retrySave: async () => undefined,
}));
vi.mock("../ai/useAssistantSessions", () => ({ useAssistantSessions: () => sessionsStub }));

// T8：错误区状态由 chat run stub 控制（错误分支此前零覆盖）。
const chatRunStub = vi.hoisted(() => {
  const stub = {
    answer: "", setAnswer: (_v: unknown) => undefined,
    execution: undefined,
    busy: false,
    stopped: false, setStopped: (_v: unknown) => undefined,
    error: undefined as string | undefined, setError: (_v: unknown) => undefined,
    lastPrompt: "统计摄像头", setLastPrompt: (_v: unknown) => undefined,
    lastScope: "模组线", setLastScope: (_v: unknown) => undefined,
    dashboard: undefined, setDashboard: (_v: unknown) => undefined,
    bimEvidence: undefined, setBimEvidence: (_v: unknown) => undefined,
    requestAbort: { current: undefined },
    cancelRequest: () => undefined,
    ask: async () => undefined,
  };
  return { stub, __set: (patch: Partial<typeof stub>) => { Object.assign(stub, patch); } };
});
vi.mock("../ai/useAssistantChatRun", () => ({ useAssistantChatRun: () => chatRunStub.stub }));

import { AiAssistantPanel } from "./AiAssistantPanel";

describe("AiAssistantPanel", () => {
  it("bounds the Studio assistant to its actual viewport rather than subtracting fixed sidebars twice", async () => {
    const css = await readFile(new URL("../styles/platform-pages.css", import.meta.url), "utf8");
    expect(css).toContain(".ai-assistant-studio { right: clamp(12px, calc(100% - 444px), 298px); width: min(420px, calc(100% - 24px));");
  });
  it("uses scene and selected-object modes in Studio without losing the shared AI workflow", () => {
    const html = renderToStaticMarkup(
      <AiAssistantPanel
        locale="zh-CN"
        projectId="project-1"
        surface="studio"
        context={{
          project: { id: "project-1", name: "电池工厂" },
          scene: { id: "scene-1", name: "模组线", modelCount: 4 },
          selected: { id: "robot-1", name: "搬运机器人", kind: "model" },
          dashboard: { widgets: [] },
        }}
        onApplyDashboard={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(html).toContain("场景");
    expect(html).toContain("对象");
    expect(html).toContain("仿真运营");
    expect(html).toContain("看板");
    expect(html).toContain("问数据");
    expect(html).toContain("执行任务");
    expect(html).toContain("搬运机器人");
    expect(html).toContain('data-drag-handle="true"');
    // 体验切换为带文字的分段按钮；范围收进输入框工具栏的单个下拉，不再是一整行纯图标页签。
    expect(html).toContain("<span>对话</span>");
    expect(html).toContain("<span>执行任务</span>");
    expect(html).toContain('aria-label="提问范围"');
    expect(html).toMatch(/<option value="scene" selected="">场景<\/option>/);
    expect(html).not.toContain("ai-assistant-tabs");
    expect(html).not.toContain('aria-pressed=');
  });

  it("drops the separate tab row and keeps the panel to header / body / composer", async () => {
    const chrome = await readFile(new URL("../styles/platform-pages.css", import.meta.url), "utf8");
    const reliability = await readFile(new URL("./AiAssistantReliability.css", import.meta.url), "utf8");

    expect(chrome).not.toContain(".ai-assistant-panel > nav");
    expect(chrome).toContain("grid-template-rows: auto minmax(0, 1fr) auto;");
    expect(reliability).toMatch(/\.ai-assistant-experience\s*\{[\s\S]*?display: flex;[\s\S]*?flex: 0 0 auto;/);
  });

  it("reuses the shared assistant workflow for the 2D workspace", () => {
    const html = renderToStaticMarkup(<AiAssistantPanel locale="zh-CN" projectId="project-1" surface="platform"
      context={{ project: { id: "project-1", name: "工厂" }, currentView: "dashboard", dashboard: { id: "page-1", name: "总览", widgets: [{ id: "kpi" }] } }}
      onValidateDashboardPageDraft={() => ({ changeCount: 1, labels: ["产量"] })}
      onApplyDashboardPageDraft={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("二维 AI 助手");
    expect(html).toMatch(/<option value="dashboard" selected="">二维<\/option>/);
    expect(html).toContain("当前二维看板草稿");
    expect(html).toContain("会话模型");
    expect(html).toContain("向 AI 助手提问");
  });

  it("mounts the memory and provenance panels in the chat view as collapsible rows (K14)", () => {
    const html = renderToStaticMarkup(
      <AiAssistantPanel
        locale="zh-CN"
        projectId="project-1"
        surface="studio"
        context={{ project: { id: "project-1", name: "电池工厂" }, scene: { id: "scene-1", name: "模组线", modelCount: 4 } }}
        onClose={vi.fn()}
      />,
    );
    // chat 侧与 agent start 视图同构的两个折叠行（默认收起）。
    expect(html).toContain('aria-label="项目记忆"');
    expect(html).toContain('aria-label="实验档案"');
    expect(html).not.toContain('aria-label="项目记忆" open');
  });

  it("keeps the memory and provenance panels out of the chat view when no project is selected (permission gate)", () => {
    const html = renderToStaticMarkup(
      <AiAssistantPanel locale="zh-CN" projectId={undefined} surface="studio"
        context={{ project: { name: "未选项目" } }} onClose={vi.fn()} />,
    );
    expect(html).not.toContain('aria-label="项目记忆"');
    expect(html).not.toContain('aria-label="实验档案"');
  });

  // ── K6 回归（审计 §一 K6：6 轮窗口裁剪零披露）──

  it("K6: discloses the trimmed history window once the conversation exceeds six turns", () => {
    sessionsStub.conversation = Array.from({ length: 7 }, (_, index) => ({ id: `m${index}`, question: "q", answer: "a", mode: "scene" }));
    try {
      const html = renderToStaticMarkup(
        <AiAssistantPanel locale="zh-CN" projectId="project-1" surface="studio"
          context={{ project: { id: "project-1", name: "电池工厂" }, scene: { id: "scene-1", name: "模组线", modelCount: 4 } }}
          onClose={vi.fn()} />,
      );
      expect(html).toContain("仅发送最近 6 轮对话");
      expect(html).toContain("更早的 1 轮");
    } finally {
      sessionsStub.conversation = [];
    }
  });

  it("K6: keeps the disclosure silent while the conversation fits the window", () => {
    sessionsStub.conversation = Array.from({ length: 6 }, (_, index) => ({ id: `m${index}`, question: "q", answer: "a", mode: "scene" }));
    try {
      const html = renderToStaticMarkup(
        <AiAssistantPanel locale="zh-CN" projectId="project-1" surface="studio"
          context={{ project: { id: "project-1", name: "电池工厂" }, scene: { id: "scene-1", name: "模组线", modelCount: 4 } }}
          onClose={vi.fn()} />,
      );
      expect(html).not.toContain("仅发送最近");
    } finally {
      sessionsStub.conversation = [];
    }
  });

  // ── K3 回归接线：dashboard 模式 busy 占位（SSR 无法触发流式，接线由源断言锁死）──

  it("K3: wires the dashboard busy placeholder into the message flow", async () => {
    const source = await readFile(new URL("./AiAssistantPanel.tsx", import.meta.url), "utf8");
    expect(source).toContain('busyHint: t("正在生成结构化方案…", "Generating a structured plan…")');
    const messages = await readFile(new URL("./AiAssistantMessages.tsx", import.meta.url), "utf8");
    expect(messages).toContain("busyHint ?? ");
  });
  // ── T8 回归（审计 §二 2.3：失败仅"重试原问题"一条路，无备用模型/受控问数）──
  it("T8: offers three recovery paths on failure: plain retry, alternate model, controlled data query", () => {
    chatRunStub.__set({ error: "服务暂时不可用", lastPrompt: "统计摄像头" });
    try {
      const html = renderToStaticMarkup(
        <AiAssistantPanel locale="zh-CN" projectId="project-1" surface="studio"
          context={{ project: { id: "project-1", name: "电池工厂" }, scene: { id: "scene-1", name: "模组线", modelCount: 4 } }}
          onClose={vi.fn()} />,
      );
      expect(html).toContain("本次请求未完成");
      expect(html).toContain("重试原问题");
      expect(html).toContain("换备用模型重试");
      expect(html).toContain("改用受控问数");
      expect(html).toContain("ai-assistant-error-actions");
    } finally {
      chatRunStub.__set({ error: undefined });
    }
  });

  it("T8: hides the controlled-query fallback when no project is selected (mode cannot carry data)", () => {
    chatRunStub.__set({ error: "服务暂时不可用", lastPrompt: "统计摄像头" });
    try {
      const html = renderToStaticMarkup(
        <AiAssistantPanel locale="zh-CN" projectId={undefined} surface="studio"
          context={{ project: { name: "未选项目" } }} onClose={vi.fn()} />,
      );
      expect(html).toContain("换备用模型重试");
      expect(html).not.toContain("改用受控问数");
    } finally {
      chatRunStub.__set({ error: undefined });
    }
  });

  // ── T9 回归（审计 §二 2.4：能力目录仅空态可见，对话进行中能力发现通道关闭）──
  it("T9: keeps a persistent capability drawer during an active conversation, collapsed by default", () => {
    sessionsStub.conversation = [{ id: "m1", question: "q", answer: "a", mode: "scene" }];
    try {
      const html = renderToStaticMarkup(
        <AiAssistantPanel locale="zh-CN" projectId="project-1" surface="studio"
          context={{ project: { id: "project-1", name: "电池工厂" }, scene: { id: "scene-1", name: "模组线", modelCount: 4 } }}
          onClose={vi.fn()} />,
      );
      expect(html).toContain('aria-label="可用能力"');
      // 折叠态不挂载目录（避免双请求）：空态专属的完整目录文案不出现。
      expect(html).not.toContain("当前可用智能任务");
      expect(html).toContain("展开查看与提问");
    } finally {
      sessionsStub.conversation = [];
    }
  });

  it("T9: the empty state uses the same collapsed capability drawer and one-tap suggestions", () => {
    const html = renderToStaticMarkup(
      <AiAssistantPanel locale="zh-CN" projectId="project-1" surface="studio"
        context={{ project: { id: "project-1", name: "电池工厂" }, scene: { id: "scene-1", name: "模组线", modelCount: 4 } }}
        onClose={vi.fn()} />,
    );
    expect(html).toContain('aria-label="可用能力"');
    expect(html).not.toContain("正在发现插件能力");
    expect(html).toContain("检查当前场景的对象、数据绑定和交互缺口");
    // 建议即点即问，旧的重复"一键运行样例"入口已移除。
    expect(html).not.toContain("一键运行样例");
  });

  it("folds context, memory and provenance into one collapsed context row", () => {
    const html = renderToStaticMarkup(
      <AiAssistantPanel locale="zh-CN" projectId="project-1" surface="studio"
        context={{ project: { id: "project-1", name: "电池工厂" }, scene: { id: "scene-1", name: "模组线", modelCount: 4 } }}
        onClose={vi.fn()} />,
    );
    expect(html).toContain('aria-label="本次上下文"');
    expect(html).not.toContain('aria-label="本次上下文" open');
    const group = html.slice(html.indexOf('aria-label="本次上下文"'));
    expect(group.indexOf('aria-label="项目记忆"')).toBeLessThan(group.indexOf('aria-label="可用能力"'));
  });

  // ── T10 回归（审计 §二 2.4：chat 侧记忆/档案空态带首次引导与一键切换，经面板接线）──
  it("T10: wires the chat memory/provenance first-use guide with an open-agent action", () => {
    const html = renderToStaticMarkup(
      <AiAssistantPanel locale="zh-CN" projectId="project-1" surface="studio"
        context={{ project: { id: "project-1", name: "电池工厂" }, scene: { id: "scene-1", name: "模组线", modelCount: 4 } }}
        onClose={vi.fn()} />,
    );
    expect(html).toContain("ai-firstuse-guide");
    expect(html).toContain("去「执行任务」运行一次假设验证");
  });
});
