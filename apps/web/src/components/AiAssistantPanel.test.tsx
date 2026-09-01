import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ api: {} }));

import { AiAssistantPanel } from "./AiAssistantPanel";

describe("AiAssistantPanel", () => {
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
    expect(html).toContain("快照只作为模型输入");
  });
});
