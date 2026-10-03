import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SceneBehaviorModule } from "@bim-studio/scene-sdk";
import { SceneBehaviorPanel, sceneScriptResourceSnippet } from "./SceneBehaviorPanel";
import type { SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import type { ScriptModule } from "@bim-studio/contracts";

const scheduler = { state: "running", elapsedMs: 900, fixedElapsedMs: 0, frame: 54, sequence: 2, pendingFixedMs: 0, droppedFixedSteps: 0, lastFrameDeltaMs: 16, timeScale: 1 };
const behaviorModule = (id: string): SceneBehaviorModule =>
  ({ id, name: id, apiVersion: "1.0", code: "function onStart(ctx) {}", lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: ["scene.write"] });
const scriptOf = (id: string): ScriptModule =>
  ({ id, name: "热插示例", code: "function onStart(ctx) {}", apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", enabled: true, lifecycle: ["onStart", "onStop", "onDispose"], capabilities: ["studio.runtime"], permissions: ["scene.write"], target: { kind: "scene" } });
const entryOf = (id: string, status: SceneBehaviorManagerEntry["diagnostics"]["status"], moduleId = id): SceneBehaviorManagerEntry => ({
  module: behaviorModule(id),
  diagnostics: {
    status, moduleId, pendingInvocations: 0, completedInvocations: 2, droppedInvocations: 0,
    rejectedCommands: 0, averageExecutionMs: 1, lastExecutionMs: 1, scheduler,
  } as SceneBehaviorManagerEntry["diagnostics"],
});
const panelProps = (overrides: Record<string, unknown> = {}) => ({
  locale: "zh-CN" as const,
  scripts: [scriptOf("s1")],
  dependencies: [],
  runtimeEntries: [entryOf("s1", "running")],
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
  onHotSwap: vi.fn(),
  onPauseResume: vi.fn(),
  onStop: vi.fn(),
  onClearLogs: vi.fn(),
  onOpenDocs: vi.fn(),
  resolveSceneId: vi.fn(),
  onFocusTarget: vi.fn(),
  layoutMode: "split" as const,
  onLayoutModeChange: vi.fn(),
  onClose: vi.fn(),
  ...overrides,
});

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

  it("运行中提供热插应用入口;未运行与作者调试态禁用并如实给原因(fail-closed)", () => {
    // 选中脚本在试运行中:热插应用可用,title 说明热插语义。
    const running = renderToStaticMarkup(createElement(SceneBehaviorPanel, panelProps()));
    expect(running).toContain("热插应用");
    expect(running).toContain("场景状态保留");
    expect(running).not.toContain("作者调试会话不支持运行中热插");

    // 会话在跑别的脚本,选中脚本未在试运行:按钮禁用,原因如实进 tooltip。
    const idle = renderToStaticMarkup(createElement(SceneBehaviorPanel, panelProps({ runtimeEntries: [entryOf("other", "running")] })));
    expect(idle).toContain("热插应用");
    expect(idle).toContain("未在试运行中");
    expect(idle).toContain("disabled=\"\"");

    // 作者调试会话:核心 fail-closed 语义如实呈现。
    const debugging = renderToStaticMarkup(createElement(SceneBehaviorPanel, panelProps({ debugging: true })));
    expect(debugging).toContain("作者调试会话不支持运行中热插");
    expect(debugging).toContain("fail-closed");
  });

  it("没有热插通道的会话(旧挂载方)不渲染可用入口语义缺失原因", () => {
    const legacy = renderToStaticMarkup(createElement(SceneBehaviorPanel, panelProps({ onHotSwap: undefined })));
    expect(legacy).toContain("当前会话不支持热插应用");
  });
});
