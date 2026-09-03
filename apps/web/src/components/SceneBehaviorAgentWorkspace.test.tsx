import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ScriptModule } from "@bim-studio/contracts";
import { SceneBehaviorAgentWorkspace, parseNormalizedScriptIntent } from "./SceneBehaviorAgentWorkspace";

const script: ScriptModule = {
  id: "behavior:pump",
  name: "泵组告警行为",
  enabled: true,
  apiVersion: "1.0",
  entrypoint: "behavior",
  runtime: "worker-sandbox",
  code: "function onStart(ctx) { ctx.self?.show(); }",
  lifecycle: ["onStart"],
  capabilities: ["studio.object"],
  permissions: ["scene.read", "scene.write"],
  target: { kind: "object", id: "pump-01" },
};

describe("SceneBehaviorAgentWorkspace", () => {
  it("keeps create, explain, diagnose and controlled tasks in one script AI entry", () => {
    const html = renderToStaticMarkup(
      <SceneBehaviorAgentWorkspace
        locale="zh-CN"
        projectId="project-1"
        sceneId="scene-1"
        target={{ id: "pump-01", name: "循环泵", kind: "object", context: "能源站" }}
        draft={script}
        analysis={{ lifecycle: ["onStart"], capabilities: ["studio.object"], permissions: ["scene.write"], missingCapabilities: [], missingPermissions: [], issues: [] }}
        intelligence={{ targets: [{ id: "pump-01", name: "循环泵", kind: "object", context: "能源站" }], references: [{ id: "scene-1", name: "能源站", kind: "scene", context: "能源站" }], dataKeys: ["pump.temperature"], eventNames: ["click"] }}
        onInsertIntoEditor={vi.fn()}
        onUndoInsert={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(html).toContain('aria-label="脚本 AI 能力"');
    expect(html).toContain("生成");
    expect(html).toContain("解释");
    expect(html).toContain("诊断");
    expect(html).toContain("任务");
    expect(html).toContain("泵组告警行为");
    expect(html).toContain("循环泵 · 三维对象");
    expect(html).toContain("生成并检查");
  });

  it("accepts only declarative normalized intent and rejects executable model output", () => {
    expect(parseNormalizedScriptIntent('```json\n{"normalizedIntent":"当 pump.temperature > 80 时颜色改为 #ef4444","summary":"高温变色"}\n```')).toEqual({
      normalizedIntent: "当 pump.temperature > 80 时颜色改为 #ef4444",
      summary: "高温变色",
    });
    expect(parseNormalizedScriptIntent('{"normalizedIntent":"function onStart(){ fetch(\"https://bad.example\") }"}')).toBeUndefined();
    expect(parseNormalizedScriptIntent("not json")).toBeUndefined();
  });

  it("makes undo explicit after a local AI insertion", () => {
    const html = renderToStaticMarkup(
      <SceneBehaviorAgentWorkspace
        locale="zh-CN"
        draft={script}
        intelligence={{ targets: [], references: [], dataKeys: [], eventNames: [] }}
        initialMode="diagnose"
        canUndoInsert
        onInsertIntoEditor={vi.fn()}
        onUndoInsert={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    expect(html).toContain("撤销本次 AI 插入");
    expect(html).toContain("诊断脚本");
  });
});
