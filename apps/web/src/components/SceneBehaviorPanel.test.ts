import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SceneBehaviorPanel, sceneScriptResourceSnippet } from "./SceneBehaviorPanel";

describe("sceneScriptResourceSnippet", () => {
  it("creates project-aware data snippets with safe local identifiers", () => {
    expect(sceneScriptResourceSnippet("data-read", "plant.line-1.temperature")).toBe(
      'const temperature = ctx.getData("plant.line-1.temperature");\nctx.log("plant.line-1.temperature", temperature);'
    );
    expect(sceneScriptResourceSnippet("data-write", "plant.target")).toBe('ctx.setData("plant.target", 0);');
  });

  it("creates event emit and listener snippets for the Worker runtime contract", () => {
    expect(sceneScriptResourceSnippet("event-emit", "alarm.raised")).toContain('ctx.emit("alarm.raised"');
    const listener = sceneScriptResourceSnippet("event-listen", "click");
    expect(listener).toContain("function onEvent(ctx)");
    expect(listener).toContain('ctx.event?.name === "click"');
  });

  it("keeps the script workbench focused and leaves workspace navigation to the global bar", () => {
    const html = renderToStaticMarkup(
      createElement(SceneBehaviorPanel, {
        locale: "zh-CN",
        scripts: [],
        dependencies: [],
        runtimeEntries: [],
        logs: [],
        codeTargets: [],
        intelligence: { targets: [], references: [], dataKeys: [], eventNames: [] },
        paused: false,
        autoSaveEnabled: true,
        onAutoSaveChange: vi.fn(),
        onSaveWorkspace: vi.fn(),
        onUpsert: vi.fn(),
        onDelete: vi.fn(),
        onReplaceScripts: vi.fn(),
        onDependenciesChange: vi.fn(),
        onRun: vi.fn(),
        onPauseResume: vi.fn(),
        onStop: vi.fn(),
        onClearLogs: vi.fn(),
        onOpenDocs: vi.fn(),
        resolveSceneId: vi.fn(),
        onFocusTarget: vi.fn(),
        layoutMode: "split",
        onLayoutModeChange: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(html).not.toContain('aria-label="编辑模式"');
    expect(html).not.toContain("生产应用 · 总览页面");
    expect(html).toContain('aria-label="脚本运行操作"');
    expect(html).toContain("AI 脚本助手");
    expect(html).toContain("脚本版本");
    expect(html).toContain('aria-label="收起脚本列表"');
    expect(html).toContain("独立窗口");
    expect(html).toContain('aria-label="调整脚本列表宽度"');
    expect(html).toContain("inspector-collapsed");
    expect(html).not.toContain(">AI 生成草稿<");
    expect(html).not.toContain(">应用修改<");
    expect(html).not.toContain(">还原<");
  });

  it("exposes a clear return action from the independent window", () => {
    const html = renderToStaticMarkup(createElement(SceneBehaviorPanel, {
      locale: "zh-CN", scripts: [], dependencies: [], runtimeEntries: [], logs: [], codeTargets: [],
      intelligence: { targets: [], references: [], dataKeys: [], eventNames: [] }, paused: false,
      autoSaveEnabled: true, onAutoSaveChange: vi.fn(), onSaveWorkspace: vi.fn(),
      onUpsert: vi.fn(), onDelete: vi.fn(), onReplaceScripts: vi.fn(), onDependenciesChange: vi.fn(), onRun: vi.fn(), onPauseResume: vi.fn(), onStop: vi.fn(),
      onClearLogs: vi.fn(), onOpenDocs: vi.fn(), resolveSceneId: vi.fn(), onFocusTarget: vi.fn(),
      layoutMode: "window", onLayoutModeChange: vi.fn(), onClose: vi.fn(),
    }));
    expect(html).toContain("分屏");
  });
});
