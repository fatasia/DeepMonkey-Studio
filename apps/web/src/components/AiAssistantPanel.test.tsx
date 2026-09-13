import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ api: {} }));

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
});
