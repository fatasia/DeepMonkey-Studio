import type { ComponentProps, ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_DASHBOARD_VIEW } from "../studio/workspaceRoute";
import { SceneBehaviorPanel } from "../components/SceneBehaviorPanel";
import { AppBehaviorOverlay } from "./AppBehaviorOverlay";
import type { AppViewBindings } from "./appViewBindings";

type BehaviorPanelElement = ReactElement<ComponentProps<typeof SceneBehaviorPanel>>;

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

describe("AppBehaviorOverlay workspace navigation", () => {
  it("returns from the 3D script overlay to the preserved 2D workspace", async () => {
    const { bindings, closePanel, commitSceneName, returnFromSceneEditor, saveActiveApplication } = createBindings("studio");
    const panel = AppBehaviorOverlay({ bindings }) as BehaviorPanelElement;

    await panel.props.workspaceNavigation?.onSelect2D?.();

    expect(saveActiveApplication).toHaveBeenCalledOnce();
    expect(closePanel).toHaveBeenCalledWith(false);
    expect(commitSceneName).toHaveBeenCalledOnce();
    expect(returnFromSceneEditor).toHaveBeenCalledOnce();
  });

  it("saves before opening the linked 3D scene with the current viewport state", async () => {
    const { bindings, closePanel, enterSceneFromDashboard, saveActiveApplication } = createBindings("dashboard");
    const panel = AppBehaviorOverlay({ bindings }) as BehaviorPanelElement;

    await panel.props.workspaceNavigation?.onSelect3D?.();

    expect(saveActiveApplication).toHaveBeenCalledOnce();
    expect(closePanel).toHaveBeenCalledWith(false);
    expect(enterSceneFromDashboard).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({ zoom: 0.8, scrollLeft: 120, scrollTop: 60 }),
    );
  });
});
