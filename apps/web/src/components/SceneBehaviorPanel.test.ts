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

  it("keeps 2D and 3D navigation inside the script workspace", () => {
    const html = renderToStaticMarkup(
      createElement(SceneBehaviorPanel, {
        locale: "zh-CN",
        scripts: [],
        runtimeEntries: [],
        logs: [],
        codeTargets: [],
        intelligence: { targets: [], references: [], dataKeys: [], eventNames: [] },
        workspaceNavigation: {
          contextLabel: "生产应用 · 总览页面",
          sceneAvailable: true,
          onSelect2D: vi.fn(),
          onSelect3D: vi.fn(),
        },
        paused: false,
        onUpsert: vi.fn(),
        onDelete: vi.fn(),
        onRun: vi.fn(),
        onPauseResume: vi.fn(),
        onStop: vi.fn(),
        onClearLogs: vi.fn(),
        onOpenDocs: vi.fn(),
        resolveSceneId: vi.fn(),
        onFocusTarget: vi.fn(),
        onClose: vi.fn(),
      }),
    );

    expect(html).toContain('aria-label="编辑模式"');
    expect(html).toContain("生产应用 · 总览页面");
    expect(html).toContain(">二维<");
    expect(html).toContain(">三维<");
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("inspector-collapsed");
    expect(html).toContain('aria-expanded="false"');
  });
});
