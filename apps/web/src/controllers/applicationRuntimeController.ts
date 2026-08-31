import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type {
  ApplicationDocument,
  ApplicationObjectRef,
  JsonValue,
  ProjectRecord,
  SceneInteractionTarget,
  SceneInteractionTrigger,
  SceneSnapshot,
  ScriptModule,
  SystemUserRecord,
} from "@bim-studio/contracts";
import type { SceneCommand } from "@bim-studio/scene-sdk";
import {
  createDeleteScriptModuleCommand,
  createInsertDashboardNodeCommand,
  createUpdateDashboardDataWidgetCommand,
  createUpdateDashboardNodeFrameCommand,
  createUpdateDashboardNodeStateCommand,
  createUpdateDashboardSceneViewportCommand,
  createUpsertScriptModuleCommand,
  type ApplicationInteractionResult,
  type StudioCommand,
} from "@bim-studio/studio-core";
import { api } from "../api";
import { AUTO_SAVE_STORAGE_KEY } from "../appDefaults";
import { createIndustrialShowcaseBundle } from "../showcase/industrialShowcase";
import { ApplicationSession } from "../studio/applicationSession";
import { publishApplicationInteractionEffects } from "../studio/applicationInteractionHost";
import { runTrustedApplicationScript } from "../studio/trustedApplicationScript";
import { DEFAULT_DASHBOARD_VIEW, type DashboardReturnContext, type DashboardViewState } from "../studio/workspaceRoute";
import { publishLocalSceneData } from "../sceneDataBridge";
import { authorizeSceneCommands } from "../behavior/sceneCommandPolicy";
import { resolveSceneBehaviorModule } from "../behavior/scriptModuleAdapter";
import { SceneBehaviorManager, type SceneBehaviorManagerEntry } from "../behavior/SceneBehaviorManager";
import { createLatestFrameEmitter } from "../behavior/latestFrameEmitter";
import { SceneCommandExecutor } from "../behavior/SceneCommandExecutor";
import { ViewerSceneCommandPort } from "../behavior/ViewerSceneCommandPort";
import { executeUnityScriptCommand, isUnitySceneCommand } from "../behavior/unityScriptCommandHost";
import type { SceneBehaviorLogEntry } from "../components/SceneBehaviorPanel";
import { translate as tr, type AppLocale } from "../i18n";
import type { AppRoute } from "../appRoute";
import type { ViewerEngine } from "../viewer/ViewerEngine";

type Setter<T> = Dispatch<SetStateAction<T>>;

interface ApplicationRuntimeControllerContext {
  applicationSessionRef: MutableRefObject<ApplicationSession>;
  behaviorManagerRef: MutableRefObject<SceneBehaviorManager | undefined>;
  behaviorCommandQueueRef: MutableRefObject<Promise<void>>;
  engine: ViewerEngine | undefined;
  project: ProjectRecord | undefined;
  activeScene: SceneSnapshot | undefined;
  activeApplication: ApplicationDocument | undefined;
  activeTopology: ApplicationDocument["topologies"][number] | undefined;
  managerApplications: ApplicationDocument[];
  currentUser: SystemUserRecord | undefined;
  route: AppRoute;
  locale: AppLocale;
  sceneBehaviorEntries: SceneBehaviorManagerEntry[];
  sceneBehaviorPaused: boolean;
  navigate: (route: AppRoute, replace?: boolean) => void;
  showError: (reason: unknown) => void;
  sortScenesByTime: (items: SceneSnapshot[]) => SceneSnapshot[];
  setActiveScene: Setter<SceneSnapshot | undefined>;
  setAutoSaveEnabled: Setter<boolean>;
  setBusy: Setter<boolean>;
  setExpandedModels: Setter<Set<string>>;
  setMessage: Setter<string>;
  setRevision: Setter<number>;
  setSceneBehaviorActive: Setter<boolean>;
  setSceneBehaviorEntries: Setter<SceneBehaviorManagerEntry[]>;
  setSceneBehaviorLogs: Setter<SceneBehaviorLogEntry[]>;
  setSceneBehaviorPaused: Setter<boolean>;
  setScenes: Setter<SceneSnapshot[]>;
}

/** 应用脚本、交互流、发布和二维/三维切换的统一运行时控制器。 */
export function createApplicationRuntimeController(context: ApplicationRuntimeControllerContext) {
  const {
    applicationSessionRef,
    behaviorManagerRef,
    behaviorCommandQueueRef,
    engine,
    project,
    activeScene,
    activeApplication,
    activeTopology,
    managerApplications,
    currentUser,
    route,
    locale,
    sceneBehaviorEntries,
    sceneBehaviorPaused,
    navigate,
    showError,
    sortScenesByTime,
    setActiveScene,
    setAutoSaveEnabled,
    setBusy,
    setExpandedModels,
    setMessage,
    setRevision,
    setSceneBehaviorActive,
    setSceneBehaviorEntries,
    setSceneBehaviorLogs,
    setSceneBehaviorPaused,
    setScenes,
  } = context;

  function toggleModelTree(modelId: string) {
    setExpandedModels((current) => {
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }

  function dispatchApplicationCommand(command: StudioCommand) {
    try {
      applicationSessionRef.current.store.dispatch(command);
    } catch (reason) {
      showError(reason);
    }
  }

  async function restoreScenePublication(sceneId: string, publishedAt: string) {
    if (!project) return;
    try {
      const publication = await api.restoreScenePublication(project.id, sceneId, publishedAt);
      const applyPublicationMetadata = (draft: SceneSnapshot): SceneSnapshot => ({
        ...draft,
        publishedAt: publication.publishedAt,
        publicationMode: publication.snapshot.publicationMode ?? "webgl",
        publicationPerformance: publication.snapshot.publicationPerformance ?? "standard",
        publicationToolbarVisible: publication.snapshot.publicationToolbarVisible !== false,
      });
      setScenes((items) => sortScenesByTime(items.map((item) => (item.id === sceneId ? applyPublicationMetadata(item) : item))));
      if (activeScene?.id === sceneId) setActiveScene((current) => (current ? applyPublicationMetadata(current) : current));
      if (publication.snapshot.publicationMode === "cloud") await enablePublishedCloudScene(sceneId);
      setMessage(`已恢复为发布版本 v${publication.version ?? ""}${publication.snapshot.publicationMode === "cloud" ? " · 云渲染已重新启动" : ""}`);
    } catch (reason) {
      showError(reason);
    }
  }

  async function enablePublishedCloudScene(sceneId: string) {
    if (currentUser?.role !== "admin") throw new Error(tr(locale, "只有管理员可以启动云渲染", "Only administrators can start cloud rendering"));
    await api.setCloudRenderEnabled(sceneId, true);
    return api.startCloudRenderSession(sceneId);
  }

  async function createIndustrialShowcase() {
    if (!project) return;
    const existing = managerApplications.find(
      (application) =>
        application.metadata.name === "智造园区综合案例" && application.data.variables.some((variable) => variable.id === "showcase.seed" && variable.value === "industrial-v1"),
    );
    if (existing) {
      const entryPageId = existing.publicationProfiles[0]?.entryPageId ?? existing.pages[0]?.id;
      if (!entryPageId) {
        showError(new Error("已有综合案例缺少可打开的二维页面"));
        return;
      }
      applicationSessionRef.current.openDocument(existing);
      navigate({ view: "dashboard", projectId: project.id, applicationId: existing.metadata.id, pageId: entryPageId, dashboardView: DEFAULT_DASHBOARD_VIEW });
      setMessage("已打开现有智造园区综合案例；示例创建为幂等操作，不再生成重复场景");
      return;
    }
    setBusy(true);
    const createdSceneIds: string[] = [];
    let createdApplicationId: string | undefined;
    try {
      const createdAt = new Date().toISOString();
      const bundle = createIndustrialShowcaseBundle({
        projectId: project.id,
        showcaseId: `industrial-${Date.now().toString(36)}`,
        createdAt,
      });
      const savedScenes: SceneSnapshot[] = [];
      for (const scene of bundle.scenes) {
        const saved = await api.saveScene(scene);
        savedScenes.push(saved);
        createdSceneIds.push(saved.id);
      }
      const application = await api.createApplication(bundle.application);
      createdApplicationId = application.metadata.id;
      applicationSessionRef.current.openDocument(application);
      setScenes((items) => sortScenesByTime([...savedScenes, ...items.filter((item) => !createdSceneIds.includes(item.id))]));
      setActiveScene(savedScenes[0]);
      navigate({ view: "dashboard", projectId: project.id, applicationId: application.metadata.id, pageId: bundle.entryPageId, dashboardView: DEFAULT_DASHBOARD_VIEW });
      setMessage("智造园区综合案例已创建：4 个 2D/3D 场景、模拟数据、AGV、媒体与直连接口均可编辑");
    } catch (reason) {
      if (createdApplicationId) await api.deleteApplication(project.id, createdApplicationId).catch(() => undefined);
      await Promise.all(createdSceneIds.map((sceneId) => api.deleteScene(project.id, sceneId).catch(() => undefined)));
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  function upsertBehaviorScript(script: ScriptModule) {
    dispatchApplicationCommand(createUpsertScriptModuleCommand(script));
  }

  function deleteBehaviorScript(scriptId: string) {
    if (sceneBehaviorEntries.some((entry) => entry.module.id === scriptId)) stopSceneBehaviors();
    dispatchApplicationCommand(createDeleteScriptModuleCommand(scriptId));
  }

  function appendBehaviorLog(moduleId: string, level: SceneBehaviorLogEntry["level"], text: string) {
    setSceneBehaviorLogs((current) => [...current.slice(-499), { id: crypto.randomUUID(), moduleId, level, message: text, timestamp: new Date().toISOString() }]);
  }

  function runSceneBehaviors(draft?: ScriptModule) {
    if (!activeApplication) {
      showError(new Error(tr(locale, "请先打开可编辑项目", "Open an editable project first")));
      return;
    }
    behaviorManagerRef.current?.dispose();
    const scripts = draft ? activeApplication.scripts.map((script) => (script.id === draft.id ? draft : script)) : activeApplication.scripts;
    const resolved = scripts.map((script) => ({ script, resolution: resolveSceneBehaviorModule(script) }));
    const modules = resolved.flatMap(({ resolution }) => (resolution.status === "ready" ? [resolution.module] : []));
    for (const { script, resolution } of resolved) {
      if (resolution.status === "rejected") appendBehaviorLog(script.id, "error", resolution.message);
    }
    if (modules.length === 0) {
      setSceneBehaviorEntries([]);
      setSceneBehaviorActive(false);
      showError(new Error(tr(locale, "没有可运行的 Worker 行为脚本，请先新建并启用脚本", "No runnable Worker behavior scripts. Create and enable one first.")));
      return;
    }
    const behaviorSceneId = activeScene?.id ?? activeApplication.scenes[0]?.id ?? `application:${activeApplication.metadata.id}`;
    const manager = new SceneBehaviorManager({
      hostOptions: {
        executeNetworkRequest: async ({ binding, variables }) => {
          const response = await api.executeDirectBinding(binding, variables);
          return {
            ok: true,
            status: response.status,
            data: response.data as import("@bim-studio/contracts").JsonValue,
            value: response.value as import("@bim-studio/contracts").JsonValue,
          };
        },
      },
    });
    const executor = engine && activeScene ? new SceneCommandExecutor(activeScene.id, new ViewerSceneCommandPort(engine, updateComponentFromScript)) : undefined;
    const moduleById = new Map(modules.map((module) => [module.id, module]));
    manager.onChange = createLatestFrameEmitter(setSceneBehaviorEntries);
    manager.onLog = (moduleId, entry) => appendBehaviorLog(moduleId, entry.level, entry.message);
    manager.onDataUpdates = (moduleId, updates) => {
      for (const [key, value] of Object.entries(updates)) {
        const current = applicationSessionRef.current.store.getState().variables[key];
        if (JSON.stringify(current) === JSON.stringify(value)) continue;
        applicationSessionRef.current.store.setVariable(key, value);
        publishLocalSceneData({
          source: `behavior:${moduleId}`,
          key,
          value,
          timestamp: new Date().toISOString(),
          ...(route.sceneId ? { sceneId: route.sceneId } : {}),
        });
      }
    };
    manager.onEvent = (moduleId, event) => {
      window.dispatchEvent(
        new CustomEvent("bim-studio:behavior-event", { detail: { moduleId, name: event.name, ...(event.payload === undefined ? {} : { payload: event.payload }) } }),
      );
      appendBehaviorLog(moduleId, "info", `事件：${event.name}`);
    };
    manager.onCommands = (moduleId, commands) => {
      const module = moduleById.get(moduleId);
      behaviorCommandQueueRef.current = behaviorCommandQueueRef.current
        .then(async () => {
          if (!module) {
            appendBehaviorLog(moduleId, "error", tr(locale, "命令被拒绝：脚本模块不存在", "Command rejected: behavior module not found"));
            return;
          }
          const authorization = authorizeSceneCommands(module, commands);
          for (const rejection of authorization.rejected) appendBehaviorLog(moduleId, "error", `${rejection.command.id}: ${rejection.message}`);
          for (const command of authorization.allowed.filter(
            (candidate): candidate is Extract<SceneCommand, { type: "component.update" }> => candidate.type === "component.update",
          )) {
            try {
              updateComponentFromScript(command.componentId, command.patch);
            } catch (reason) {
              appendBehaviorLog(moduleId, "error", `${command.id}: ${reason instanceof Error ? reason.message : String(reason)}`);
            }
          }
          for (const command of authorization.allowed.filter(isUnitySceneCommand)) {
            try {
              const document = applicationSessionRef.current.store.getState().document;
              if (!document) throw new Error("没有已打开的应用");
              executeUnityScriptCommand(command, {
                application: document,
                ...(project ? { project } : {}),
                updateWidget: (componentId, widget) => updateComponentFromScript(componentId, { widget }),
                dispatchAction: (detail) => window.dispatchEvent(new CustomEvent("bim-studio:unity-action", { detail })),
              });
            } catch (reason) {
              appendBehaviorLog(moduleId, "error", `${command.id}: ${reason instanceof Error ? reason.message : String(reason)}`);
            }
          }
          const sceneCommands = authorization.allowed.filter((candidate) => candidate.type !== "component.update" && !isUnitySceneCommand(candidate));
          if (!executor && sceneCommands.length > 0) {
            for (const command of sceneCommands) appendBehaviorLog(moduleId, "warn", `${command.id}: 当前在二维页面，三维命令将在进入关联场景后执行`);
          }
          const results = executor ? await executor.execute(sceneCommands) : [];
          for (const result of results) {
            if (!result.success) appendBehaviorLog(moduleId, result.code === "unsupported" ? "warn" : "error", `${result.id}: ${result.message}`);
          }
          if (results.some((result) => result.success)) setRevision((value) => value + 1);
        })
        .catch((reason) => appendBehaviorLog(moduleId, "error", reason instanceof Error ? reason.message : String(reason)));
    };
    behaviorManagerRef.current = manager;
    setSceneBehaviorLogs([]);
    setSceneBehaviorPaused(false);
    setSceneBehaviorActive(true);
    manager.start(modules, behaviorSceneId);
    setSceneBehaviorEntries(manager.entries());
    setMessage(tr(locale, `正在启动 ${modules.length} 个应用行为`, `Starting ${modules.length} application behaviors`));
  }

  function pauseResumeSceneBehaviors() {
    if (!behaviorManagerRef.current) return;
    if (sceneBehaviorPaused) behaviorManagerRef.current.resume();
    else behaviorManagerRef.current.pause();
    setSceneBehaviorPaused((value) => !value);
  }

  function stopSceneBehaviors() {
    behaviorManagerRef.current?.dispose();
    behaviorManagerRef.current = undefined;
    setSceneBehaviorEntries([]);
    setSceneBehaviorActive(false);
    setSceneBehaviorPaused(false);
    setMessage(tr(locale, "场景行为已停止", "Scene behaviors stopped"));
  }

  function dispatchApplicationInteraction(source: ApplicationObjectRef, trigger: SceneInteractionTrigger, selectSource = true, payload?: JsonValue) {
    try {
      const result = applicationSessionRef.current.store.dispatchInteraction({
        source,
        trigger,
        timestamp: new Date().toISOString(),
        selectSource,
        ...(payload !== undefined ? { payload } : {}),
      });
      publishApplicationInteractionEffects(result.effects);
      const document = applicationSessionRef.current.store.getState().document;
      if (document) {
        for (const flowId of result.matchedFlowIds) {
          const flow = document.interactions.find((candidate) => candidate.id === flowId);
          if (!flow?.legacyScript || (route.view === "studio" && source.kind === "object" && source.sceneId === activeScene?.id)) continue;
          void runTrustedApplicationScript({
            application: document,
            flow,
            source,
            trigger,
            variables: applicationSessionRef.current.store.getState().variables,
            ...(engine ? { engine } : {}),
            emitAction: (action) => publishApplicationInteractionEffects([{ flowId, source, action, timestamp: new Date().toISOString() }]),
            setData: (key, value) => {
              applicationSessionRef.current.store.setVariable(key, value);
              publishLocalSceneData({ source: "application-script", key, value, timestamp: new Date().toISOString(), ...(route.sceneId ? { sceneId: route.sceneId } : {}) });
            },
            updateComponent: updateComponentFromScript,
            log: (message, detail) => console.info(`[应用脚本:${flow.name}] ${message}`, detail),
          }).catch((reason) => showError(reason));
        }
      }
      if (result.matchedFlowIds.length > 0) {
        setMessage(`联动调试：命中 ${result.matchedFlowIds.length} 条流程 · ${Object.keys(result.variableUpdates).length} 个变量 · ${result.effects.length} 个动作`);
      }
      return result;
    } catch (reason) {
      showError(reason);
      return undefined;
    }
  }

  function updateComponentFromScript(componentIdOrName: string, patch: Record<string, unknown>) {
    const document = applicationSessionRef.current.store.getState().document;
    if (!document) throw new Error("没有已打开的应用");
    const entry = document.pages.flatMap((page) => page.nodes.map((node) => ({ page, node }))).find(({ node }) => node.id === componentIdOrName || node.name === componentIdOrName);
    if (!entry) throw new Error(`找不到组件“${componentIdOrName}”`);
    const { page, node } = entry;
    if (patch.frame && typeof patch.frame === "object") {
      const frame = { ...node.frame, ...(patch.frame as Partial<typeof node.frame>) };
      dispatchApplicationCommand(createUpdateDashboardNodeFrameCommand(page.id, node.id, frame));
    }
    const state = Object.fromEntries(["name", "visible", "selectable", "locked", "groupId", "groupName"].filter((key) => key in patch).map((key) => [key, patch[key]]));
    if (Object.keys(state).length) dispatchApplicationCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, state));
    if (node.kind === "data-widget" && patch.widget && typeof patch.widget === "object") {
      dispatchApplicationCommand(createUpdateDashboardDataWidgetCommand(page.id, node.id, { ...node.widget, ...(patch.widget as Partial<typeof node.widget>) }));
    }
    if (node.kind === "scene-viewport") {
      const viewportPatch = patch.viewport && typeof patch.viewport === "object" ? (patch.viewport as Record<string, unknown>) : patch;
      dispatchApplicationCommand(
        createUpdateDashboardSceneViewportCommand(page.id, node.id, {
          sceneId: typeof viewportPatch.sceneId === "string" ? viewportPatch.sceneId : node.sceneId,
          renderMode:
            viewportPatch.renderMode === "load-on-interaction" || viewportPatch.renderMode === "static-placeholder" || viewportPatch.renderMode === "realtime"
              ? viewportPatch.renderMode
              : node.renderMode,
          interactionPolicy:
            viewportPatch.interactionPolicy === "click-select" || viewportPatch.interactionPolicy === "display-only" || viewportPatch.interactionPolicy === "full-navigation"
              ? viewportPatch.interactionPolicy
              : node.interactionPolicy,
          ...(typeof viewportPatch.cameraViewId === "string" ? { cameraViewId: viewportPatch.cameraViewId } : node.cameraViewId ? { cameraViewId: node.cameraViewId } : {}),
        }),
      );
    }
  }

  function dispatchDashboardNodeInteraction(nodeId: string, trigger: SceneInteractionTrigger = "click", payload?: JsonValue): ApplicationInteractionResult | undefined {
    return dispatchApplicationInteraction({ kind: "widget", id: nodeId }, trigger, false, payload);
  }

  function dispatchSceneObjectInteraction(sceneId: string, trigger: SceneInteractionTrigger, target: SceneInteractionTarget) {
    if (target.kind !== "object") return;
    dispatchApplicationInteraction({ kind: "object", sceneId, modelId: target.modelId, ...(target.layerId ? { layerId: target.layerId } : {}) }, trigger);
  }

  async function saveActiveApplication(automatic = false): Promise<ApplicationDocument | undefined> {
    const document = applicationSessionRef.current.store.getState().document;
    if (!document) return;
    if (!automatic) setBusy(true);
    try {
      const saved = await api.saveApplication(document);
      applicationSessionRef.current.acknowledgeSave(saved);
      if (!automatic) setMessage(`项目“${saved.metadata.name}”已保存`);
      return saved;
    } catch (reason) {
      showError(reason);
    } finally {
      if (!automatic) setBusy(false);
    }
  }

  async function publishActiveApplication() {
    const current = applicationSessionRef.current.store.getState();
    const saved = current.dirty ? await saveActiveApplication() : current.document;
    if (!saved) return;
    setBusy(true);
    try {
      await api.publishApplication(saved.metadata.projectId, saved.metadata.id);
      setMessage(`应用“${saved.metadata.name}”已发布`);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  function changeAutoSave(enabled: boolean) {
    setAutoSaveEnabled(enabled);
    window.localStorage.setItem(AUTO_SAVE_STORAGE_KEY, String(enabled));
    setMessage(enabled ? "已开启自动保存" : "已关闭自动保存");
  }

  function insertActiveTopologyIntoDashboard() {
    if (!activeApplication || !activeTopology) return;
    const page = activeApplication.pages[0];
    if (!page) return;
    const usedNames = new Set(page.nodes.map((node) => (node.name ?? node.id).trim().toLocaleLowerCase()));
    let name = activeTopology.name.trim() || "拓扑";
    let suffix = 2;
    while (usedNames.has(name.toLocaleLowerCase())) name = `${activeTopology.name || "拓扑"} ${suffix++}`;
    const nodeId = `data-widget:${crypto.randomUUID()}`;
    dispatchApplicationCommand(
      createInsertDashboardNodeCommand(page.id, {
        id: nodeId,
        name,
        kind: "data-widget",
        frame: { x: 48, y: 48, width: Math.min(720, Math.max(320, page.width - 96)), height: Math.min(460, Math.max(220, page.height - 96)) },
        zIndex: Math.max(0, ...page.nodes.map((node) => node.zIndex)) + 1,
        widget: { title: activeTopology.name, key: "", unit: "", type: "topology", topologyId: activeTopology.id, backgroundColor: "#11191d", backgroundOpacity: 0.94 },
      }),
    );
    navigate({
      view: "dashboard",
      projectId: activeApplication.metadata.projectId,
      applicationId: activeApplication.metadata.id,
      pageId: page.id,
      dashboardView: DEFAULT_DASHBOARD_VIEW,
    });
    setMessage(`拓扑“${activeTopology.name}”已插入看板，可与三维组件同页编排`);
  }

  function enterSceneFromDashboard(sceneId: string, view: DashboardViewState) {
    if (!route.projectId || !route.applicationId || !route.pageId) return;
    const dashboardReturn: DashboardReturnContext = { kind: "dashboard", projectId: route.projectId, applicationId: route.applicationId, pageId: route.pageId, view };
    setActiveScene(undefined);
    navigate({ view: "studio", projectId: route.projectId, applicationId: route.applicationId, pageId: route.pageId, sceneId, dashboardReturn });
  }

  function returnFromSceneEditor() {
    const target = route.dashboardReturn;
    if (target) {
      navigate({ view: "dashboard", projectId: target.projectId, applicationId: target.applicationId, pageId: target.pageId, dashboardView: target.view });
    } else {
      navigate({ view: "manager" });
    }
  }
  return {
    toggleModelTree,
    dispatchApplicationCommand,
    restoreScenePublication,
    enablePublishedCloudScene,
    createIndustrialShowcase,
    upsertBehaviorScript,
    deleteBehaviorScript,
    runSceneBehaviors,
    pauseResumeSceneBehaviors,
    stopSceneBehaviors,
    dispatchApplicationInteraction,
    updateComponentFromScript,
    dispatchDashboardNodeInteraction,
    dispatchSceneObjectInteraction,
    saveActiveApplication,
    publishActiveApplication,
    changeAutoSave,
    insertActiveTopologyIntoDashboard,
    enterSceneFromDashboard,
    returnFromSceneEditor,
  };
}

export type ApplicationRuntimeController = ReturnType<typeof createApplicationRuntimeController>;
