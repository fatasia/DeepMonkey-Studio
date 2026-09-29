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
    expect(html).toContain("正在发现插件能力");
    expect(html).toContain("看板");
    expect(html).toContain("问数据");
    expect(html).toContain("执行任务");
    expect(html).toContain("搬运机器人");
    expect(html).toContain('data-drag-handle="true"');
    expect(html).toContain('title="问答与生成" aria-label="问答与生成"');
    expect(html).toContain('title="执行任务" aria-label="执行任务"');
    expect(html).toContain('title="场景" aria-label="场景"');
    expect(html).not.toContain(">问答与生成</button>");
    expect(html).not.toContain(">执行任务</button>");
  });

  it("keeps every assistant tab icon in one horizontal row", async () => {
    const chrome = await readFile(new URL("../styles/platform-pages.css", import.meta.url), "utf8");
    const reliability = await readFile(new URL("./AiAssistantReliability.css", import.meta.url), "utf8");

    expect(chrome).toContain(".ai-assistant-panel > nav { display: flex; align-items: center;");
    expect(reliability).toMatch(/\.ai-assistant-experience\s*\{[\s\S]*?display: flex;[\s\S]*?flex: 0 0 auto;/);
  });

  it("reuses the shared assistant workflow for the 2D workspace", () => {
    const html = renderToStaticMarkup(<AiAssistantPanel locale="zh-CN" projectId="project-1" surface="platform"
      context={{ project: { id: "project-1", name: "工厂" }, currentView: "dashboard", dashboard: { id: "page-1", name: "总览", widgets: [{ id: "kpi" }] } }}
      onValidateDashboardPageDraft={() => ({ changeCount: 1, labels: ["产量"] })}
      onApplyDashboardPageDraft={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("二维 AI 助手");
    expect(html).toContain('title="二维" aria-label="二维" aria-pressed="true"');
    expect(html).toContain("当前二维看板草稿");
    expect(html).toContain("会话模型");
    expect(html).toContain("会话思考档位");
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
});
