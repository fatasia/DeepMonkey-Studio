import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DASHBOARD_VIEW } from "../studio/workspaceRoute";
import { AppBehaviorOverlay, behaviorWindowTitle } from "./AppBehaviorOverlay";
import type { AppViewBindings } from "./appViewBindings";

function createBindings(view: "dashboard" | "studio"): {
  bindings: AppViewBindings;
  closePanel: ReturnType<typeof vi.fn>;
  commitSceneName: ReturnType<typeof vi.fn>;
  enterSceneFromDashboard: ReturnType<typeof vi.fn>;
  returnFromSceneEditor: ReturnType<typeof vi.fn>;
  saveActiveApplication: ReturnType<typeof vi.fn>;
} {
  const closePanel = vi.fn();
  const commitSceneName = vi.fn().mockResolvedValue(true);
  const enterSceneFromDashboard = vi.fn();
  const returnFromSceneEditor = vi.fn();
  const saveActiveApplication = vi.fn().mockResolvedValue({ metadata: { id: "application-1" } });
  const dashboardView = { ...DEFAULT_DASHBOARD_VIEW, zoom: 0.8, scrollLeft: 120, scrollTop: 60 };
  const application = {
    metadata: { id: "application-1", projectId: "project-1", name: "生产应用" },
    scripts: [],
    pages: [],
    scenes: [],
  };
  const dashboardPage = {
    id: "page-1",
    name: "生产总览",
    nodes: [{ id: "viewport-1", kind: "scene-viewport", sceneId: "scene-1" }],
  };
  const route = view === "dashboard"
    ? { view, projectId: "project-1", applicationId: "application-1", pageId: "page-1", dashboardView }
    : {
        view,
        projectId: "project-1",
        applicationId: "application-1",
        sceneId: "scene-1",
        dashboardReturn: {
          kind: "dashboard",
          projectId: "project-1",
          applicationId: "application-1",
          pageId: "page-1",
          view: dashboardView,
        },
      };

  const bindings = {
    state: {
      sceneBehaviorOpen: true,
      sceneBehaviorLayout: "split",
      setSceneBehaviorLayout: vi.fn(),
      activeApplication: application,
      activeDashboardPage: view === "dashboard" ? dashboardPage : undefined,
      activeScene: { id: "scene-1", name: "装配车间" },
      applicationState: { selection: [] },
      locale: "zh-CN",
      route,
      setSceneBehaviorOpen: closePanel,
      setSceneBehaviorLogs: vi.fn(),
      setMessage: vi.fn(),
      pendingSceneFocusRef: { current: undefined },
      pendingBehaviorDraftRef: { current: undefined },
      applicationSessionRef: { current: { store: { setSelection: vi.fn() } } },
      sceneBehaviorEntries: [],
      sceneBehaviorLogs: [],
      sceneBehaviorPaused: false,
    },
    derived: {
      behaviorCodeTargets: [],
      selectedBehaviorTarget: undefined,
      behaviorScriptContext: { targets: [], references: [], dataKeys: [], eventNames: [] },
      selectedComponent: undefined,
    },
    sceneEditor: { focusComponent: vi.fn() },
    scenePersistence: { commitSceneName },
    applicationRuntime: {
      enterSceneFromDashboard,
      returnFromSceneEditor,
      upsertBehaviorScript: vi.fn(),
      deleteBehaviorScript: vi.fn(),
      runSceneBehaviors: vi.fn(),
      pauseResumeSceneBehaviors: vi.fn(),
      stopSceneBehaviors: vi.fn(),
      saveActiveApplication,
    },
    actions: { navigate: vi.fn(), openDocs: vi.fn() },
  } as unknown as AppViewBindings;

  return { bindings, closePanel, commitSceneName, enterSceneFromDashboard, returnFromSceneEditor, saveActiveApplication };
}

describe("AppBehaviorOverlay workspace integration", () => {
  it("uses the active workspace in the detached editor title", () => {
    expect(behaviorWindowTitle("zh-CN", "一号物流车间", "自定义品牌")).toBe("一号物流车间 · 脚本编辑器 · 自定义品牌");
  });

  it("renders the script editor inside the selected workspace layout", () => {
    const { bindings } = createBindings("studio");
    const html = renderToStaticMarkup(<AppBehaviorOverlay bindings={bindings} />);

    expect(html).toContain("behavior-workspace-slot layout-split");
    expect(html).toContain("正在加载脚本编辑器");
  });

  it("keeps workspace switching out of the script panel title bar", () => {
    const { bindings } = createBindings("dashboard");
    const html = renderToStaticMarkup(<AppBehaviorOverlay bindings={bindings} />);

    expect(html).not.toContain("workspace-mode-switch");
  });
});
