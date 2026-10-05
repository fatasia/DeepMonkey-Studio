import { ArrowLeft, Bot, LayoutDashboard, Play, Plus, Redo2, Rocket, Save, Square, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { SceneWorkspaceMoreMenu } from "../components/SceneWorkspaceMoreMenu";
import { SceneDrillWizard } from "../components/SceneDrillWizard";
import { PathTraceAuthorDialog } from "../components/PathTraceAuthorDialog";
import { WorkspaceModeSwitch } from "../components/WorkspaceModeSwitch";
import { flushPendingBehaviorDraft } from "../behavior/behaviorDraftNavigation";
import { disambiguatedProjectLabels } from "../studio/projectNameDisambiguation";
import { translate as tr } from "../i18n";
import type { AppViewBindings } from "./appViewBindings";

/** 三维编辑/浏览的全局导航与发布操作；与场景画布和检查器职责分离。 */
export interface AppWorkspaceTopbarTools {
  onImportModel?: () => void;
  onDeviceLayout?: () => void;
  onSmartBinding?: () => void;
  onModelDiff?: () => void;
  onRvtImportSettings?: () => void;
}

export function AppWorkspaceTopbar({ bindings, tools }: { bindings: AppViewBindings; tools?: AppWorkspaceTopbarTools }) {
  const [drillGuideOpen, setDrillGuideOpen] = useState(false);
  const [pathTraceOpen, setPathTraceOpen] = useState(false);
  const latestBindings = useRef(bindings);
  latestBindings.current = bindings;
  const exitPending = useRef(false);
  const scriptOpening = useRef(false);
  const { state, scenePersistence, applicationRuntime, actions, sceneHistory, playMode } = bindings;
  const {
    branding,
    route,
    activeApplication,
    project,
    projects,
    locale,
    sceneName,
    setSceneName,
    activeScene,
    busy,
    rendererDiagnosticsOpen,
    setRendererDiagnosticsOpen,
    rendererSwitching,
    rendererBackend,
    rendererActiveBackend,
    rendererSwitchPhase,
    rendererSwitchMessage,
    aiAssistantOpen,
    setAiAssistantOpen,
    importRef,
    sceneBehaviorOpen,
    setSceneBehaviorOpen,
    setStudioPublishMode,
    setStudioPublishPerformance,
    setStudioPublishOpen,
    autoSaveEnabled,
    rendererDiagnostics,
  } = state;
  const { commitSceneName, exportSceneConfig, exportSingleFileScene, exportGlbScene, exportFbxScene, browseActiveScene, saveScene } = scenePersistence;
  const { publishActiveApplication, changeAutoSave, upsertBehaviorScript } = applicationRuntime;
  const { switchProjectById, openProjectDialog, changeRendererBackend, navigate } = actions;
  // F10：重名项目在下拉中以创建日期消歧（缺失时间回退 ID 尾号），无同名保持原名。
  const projectOptionLabels = disambiguatedProjectLabels(projects);
  const flushBehaviorDraft = () => {
    const result = flushPendingBehaviorDraft(state.pendingBehaviorDraftRef, upsertBehaviorScript);
    if (result === "write-rejected") return false;
    if (result === "name-required") {
      state.setError(tr(locale, "请先填写脚本名称，再离开脚本编辑器", "Enter a script name before leaving the script editor"));
      return false;
    }
    return true;
  };
  const showThreeDimensionalWorkspace = () => {
    if (!flushBehaviorDraft()) return;
    setSceneBehaviorOpen(false);
  };
  const showScripts = async () => {
    if (!activeScene || scriptOpening.current) return;
    scriptOpening.current = true;
    const isCurrent = () => latestBindings.current.state.route === route;
    try {
      // 旧式场景直达链接不含应用身份；先恢复已有脚本所属文档再打开面板。
      const application = await scenePersistence.ensureApplicationForScene(activeScene, isCurrent);
      if (!isCurrent()) return;
      if (route.applicationId !== application.metadata.id) navigate({ ...route, projectId: activeScene.projectId, applicationId: application.metadata.id }, true);
      setSceneBehaviorOpen(true);
    } catch (reason) {
      if (isCurrent()) state.showError(reason);
    } finally { scriptOpening.current = false; }
  };
  const leaveThreeDimensionalWorkspace = (destination?: "dashboard") => {
    if (playMode?.active || exitPending.current || !flushBehaviorDraft()) return;
    exitPending.current = true;
    setSceneBehaviorOpen(false);
    globalThis.setTimeout(() => {
      void (async () => {
        // 脚本草稿提交后的下一帧读取最新控制器；三维离开必须保存真实视口，而非只存应用文档。
        const current = latestBindings.current;
        if (current.state.route !== route) return;
        if (current.state.activeScene) {
          if (!current.state.sceneName.trim()) { await current.scenePersistence.commitSceneName(); return; }
          // P2-5（2026-10-06 对抗测试第二轮 §4.2）："返回二维"曾被大场景的同步网络保存
          // 阻塞十几秒才生效。修复 = 画布事实（作者快照+缩略图）在引擎存活时同步预捕获，
          // 导航立即生效，持久化转后台执行；预捕获不可用（引擎未就绪/已释放）时退回
          // "保存成功才离开"的旧契约，不为速度牺牲数据安全。
          const carry = current.scenePersistence.captureSceneSaveCarry?.();
          if (carry) {
            if (latestBindings.current.state.route === route) await current.applicationRuntime.returnFromSceneEditor(destination);
            await current.scenePersistence.saveScene(false, carry);
            return;
          }
          if (!(await current.scenePersistence.saveScene())) return;
        } else if (current.state.activeApplication && !(await current.applicationRuntime.saveActiveApplication())) return;
        if (latestBindings.current.state.route === route) await current.applicationRuntime.returnFromSceneEditor(destination);
      })().catch(state.showError).finally(() => { exitPending.current = false; });
    }, 0);
  };

  return (
    <><header className="topbar">
      {route.view === "studio" && (
        <button
          className="topbar-back"
          title={route.dashboardReturn ? tr(locale, "返回二维设计", "Back to 2D design") : tr(locale, "返回场景管理", "Back to scenes")}
          onClick={() => leaveThreeDimensionalWorkspace()}
        >
          <ArrowLeft size={15} />
          <span>{route.dashboardReturn ? tr(locale, "返回二维", "Back to 2D") : tr(locale, "场景管理", "Scenes")}</span>
        </button>
      )}
      {route.view !== "studio" && (
        <button
          className="topbar-back"
          title={tr(locale, "返回场景管理", "Back to scenes")}
          onClick={() => navigate({ view: "manager" })}
        >
          <ArrowLeft size={15} />
          <span>{tr(locale, "场景管理", "Scenes")}</span>
        </button>
      )}
      {route.view !== "studio" && (
        <>
          <div className="brand-mark">
            <img src={branding.iconUrl} alt={branding.systemName} />
          </div>
          <div className="brand-copy">
            <strong>{branding.systemName}</strong>
            <span>{tr(locale, "场景浏览", "Scene viewer")}</span>
          </div>
          <div className="topbar-divider" />
        </>
      )}
      {route.view === "studio" ? (
        <>
          {route.applicationId && activeApplication ? null : (
            <>
              <select
                className="project-select"
                disabled={playMode?.active}
                title={playMode?.active ? tr(locale, "先退出播放模式，再切换项目", "Exit Play mode before switching projects") : undefined}
                value={project?.id ?? ""}
                onChange={(event) => switchProjectById(event.target.value)}
                aria-label={tr(locale, "当前项目", "Current project")}
              >
                {projects.map((item) => (
                  <option key={item.id} value={item.id} disabled={playMode?.active && item.id !== project?.id}>
                    {projectOptionLabels.get(item.id) ?? item.name}
                  </option>
                ))}
              </select>
              <button className="project-add-button" disabled={playMode?.active} title={playMode?.active ? tr(locale, "先退出播放模式", "Exit Play mode first") : tr(locale, "新建项目", "New project")} onClick={() => openProjectDialog("create")}>
                <Plus size={15} />
              </button>
            </>
          )}
          {/* 模式按钮已高亮当前模式、右侧另有可编辑场景名，面包屑属重复信息（用户反馈低级错误）已移除。 */}
          <WorkspaceModeSwitch
            locale={locale}
            active={sceneBehaviorOpen ? "script" : "3d"}
            contextLabel={sceneName}
            scriptsAvailable={Boolean(activeScene) && !playMode?.active}
            onSelect2D={() => leaveThreeDimensionalWorkspace("dashboard")}
            onSelect3D={showThreeDimensionalWorkspace}
            onSelectScripts={() => { if (!playMode?.active) void showScripts(); }}
          />
          <div className="scene-title-wrap">
            <span>{tr(locale, "场景", "Scene")}</span>
            <input
              value={sceneName}
              disabled={playMode?.active}
              title={playMode?.active ? tr(locale, "先退出播放模式，再修改场景名称", "Exit Play mode before renaming the scene") : undefined}
              onChange={(event) => setSceneName(event.target.value)}
              onBlur={() => { if (!playMode?.active) void commitSceneName(); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setSceneName(activeScene?.name ?? "未命名场景");
                  event.currentTarget.blur();
                }
              }}
              aria-label={tr(locale, "场景名称", "Scene name")}
            />
          </div>
          <div className="scene-history-controls" aria-label={tr(locale, "三维编辑历史", "3D edit history")}>
            <button
              disabled={!sceneHistory.canUndo || busy || playMode?.active}
              aria-label={playMode?.active ? tr(locale, "播放中不可撤销", "Undo unavailable during Play") : sceneHistory.undoLabel ? `${tr(locale, "撤销", "Undo")}：${sceneHistory.undoLabel}` : tr(locale, "暂无可撤销操作", "Nothing to undo")}
              title={playMode?.active ? tr(locale, "先退出播放模式，再撤销", "Exit Play mode before undo") : sceneHistory.undoLabel ? `${tr(locale, "撤销", "Undo")}：${sceneHistory.undoLabel} · Ctrl+Z` : tr(locale, "暂无可撤销操作", "Nothing to undo")}
              onClick={() => void sceneHistory.undo()}
            >
              <Undo2 size={15} />
            </button>
            <button
              disabled={!sceneHistory.canRedo || busy || playMode?.active}
              aria-label={playMode?.active ? tr(locale, "播放中不可重做", "Redo unavailable during Play") : sceneHistory.redoLabel ? `${tr(locale, "重做", "Redo")}：${sceneHistory.redoLabel}` : tr(locale, "暂无可重做操作", "Nothing to redo")}
              title={playMode?.active ? tr(locale, "先退出播放模式，再重做", "Exit Play mode before redo") : sceneHistory.redoLabel ? `${tr(locale, "重做", "Redo")}：${sceneHistory.redoLabel} · Ctrl+Y` : tr(locale, "暂无可重做操作", "Nothing to redo")}
              onClick={() => void sceneHistory.redo()}
            >
              <Redo2 size={15} />
            </button>
          </div>
          <div className="topbar-actions">
            {playMode && <button
              className={`button scene-play-action ${playMode.active ? "is-playing" : ""}`}
              type="button"
              aria-label={playMode.active ? tr(locale, "退出播放模式并恢复场景", "Exit Play and restore scene") : tr(locale, "进入播放模式", "Enter Play mode")}
              title={playMode.active ? tr(locale, "退出播放并恢复进入前的场景", "Stop and restore the scene before Play") : state.engine?.getAuthorRendererBackend() === "webgpu" ? tr(locale, "Play 暂不支持 WebGPU，请先切换 WebGL", "Play requires WebGL; switch renderer first") : tr(locale, "播放期间的修改不会保存；退出时恢复场景", "Play changes are temporary; exiting restores the scene")}
              aria-pressed={playMode.active}
              disabled={!playMode.active && (!activeScene || busy || rendererSwitching || sceneBehaviorOpen || state.sceneBehaviorActive || state.animationPlaying || state.physics?.playing || state.sceneName !== activeScene.name || state.engine?.getAuthorRendererBackend() === "webgpu")}
              onClick={() => { if (playMode.active) void playMode.exit(); else playMode.enter(); }}
            >
              {playMode.active ? <Square size={13} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
              <span className="action-label">{playMode.active ? tr(locale, "退出播放", "Stop Play") : tr(locale, "播放", "Play")}</span>
            </button>}
            <button
              className={`button ghost compact-action ${aiAssistantOpen ? "active" : ""}`}
              aria-label={tr(locale, "AI 场景助手", "AI scene assistant")}
              title={tr(locale, "AI 场景助手", "AI scene assistant")}
              onClick={() => setAiAssistantOpen((value) => !value)}
            >
              <Bot size={15} />
              <span className="action-label">{tr(locale, "AI 助手", "AI Assistant")}</span>
            </button>
            {!playMode?.active && <SceneWorkspaceMoreMenu
              onDrillGuide={() => setDrillGuideOpen(true)}
              locale={locale}
              rendererBackend={rendererActiveBackend}
              rendererDesiredBackend={rendererBackend}
              rendererSwitchPhase={rendererSwitchPhase}
              rendererSwitchMessage={rendererSwitchMessage}
              rendererSwitching={rendererSwitching}
              rendererDiagnosticsOpen={rendererDiagnosticsOpen}
              setRendererDiagnosticsOpen={(open) => setRendererDiagnosticsOpen(open)}
              rendererDiagnostics={rendererDiagnostics}
              changeRendererBackend={(backend) => {
                if (!busy) void changeRendererBackend(backend);
              }}
              onImportModel={tools?.onImportModel}
              onDeviceLayout={tools?.onDeviceLayout}
              onSmartBinding={tools?.onSmartBinding}
              onModelDiff={tools?.onModelDiff}
              onRvtImportSettings={tools?.onRvtImportSettings}
              onImport={() => importRef.current?.click()}
              onExportLoose={() => exportSceneConfig()}
              onExportSingle={() => void exportSingleFileScene()}
              onExportGlb={() => void exportGlbScene()}
              onExportFbx={() => void exportFbxScene()}
              onExportPathTrace={() => setPathTraceOpen(true)}
              onBrowse={() => void browseActiveScene()}
              browseDisabled={Boolean(activeApplication) || busy}
            />}
            {activeApplication ? (
              <button
                className="button ghost topbar-publish-action"
                aria-label={tr(locale, "发布应用", "Publish app")}
                title={tr(locale,
                  "零配置一键发布：按当前保存内容原样发布为在线浏览版本——浏览器渲染，画布与分辨率沿用各页面设置，不生成本地安装包。离线运行包请用二维看板工具栏的「离线包」。",
                  "Zero-config one-click publish: republishes the saved content as an online browsable version — rendered in the browser, canvas and resolution follow each page's settings, and no native package is built. Use Offline in the dashboard toolbar for offline runtime packages.")}
                onClick={() => void saveScene().then((saved) => saved && publishActiveApplication())}
                disabled={busy || playMode?.active}
              >
                <Rocket size={15} />
                <span className="action-label">{tr(locale, "发布应用", "Publish app")}</span>
              </button>
            ) : (
              <button
                className="button ghost topbar-publish-action"
                aria-label={activeScene?.publishedAt ? tr(locale, "重新发布场景", "Republish scene") : tr(locale, "发布场景", "Publish scene")}
                title={activeScene?.publishedAt ? tr(locale, "重新发布场景", "Republish scene") : tr(locale, "发布场景", "Publish scene")}
                onClick={() => {
                  setStudioPublishMode(activeScene?.publicationMode ?? "webgl");
                  setStudioPublishPerformance(activeScene?.publicationPerformance ?? "standard");
                  setStudioPublishOpen(true);
                }}
                disabled={busy || playMode?.active}
              >
                <Rocket size={15} />
                <span className="action-label">{activeScene?.publishedAt ? tr(locale, "重新发布", "Republish") : tr(locale, "发布", "Publish")}</span>
              </button>
            )}
            <label className="topbar-auto-save" title={playMode?.active ? tr(locale, "播放中自动保存已暂停", "Auto save is paused during Play") : tr(locale, "修改后自动保存整个项目", "Automatically save project changes")}>
              <input type="checkbox" aria-label={playMode?.active ? tr(locale, "自动保存已暂停", "Auto save paused") : tr(locale, "自动保存", "Auto save")} checked={autoSaveEnabled} disabled={playMode?.active} onChange={(event) => changeAutoSave(event.target.checked)} />
              <span>{playMode?.active ? tr(locale, "自动保存已暂停", "Auto save paused") : tr(locale, "自动保存", "Auto save")}</span>
            </label>
            <button className="button primary topbar-save-action" aria-label={tr(locale, "保存项目", "Save project")} title={playMode?.active ? tr(locale, "先退出播放模式，再保存", "Exit Play mode before saving") : tr(locale, "保存项目", "Save project")} onClick={() => void saveScene()} disabled={busy || playMode?.active}>
              <Save size={15} />
              <span className="action-label">{tr(locale, "保存项目", "Save project")}</span>
            </button>
          </div>
        </>
      ) : (
        <div className="viewer-scene-title">
          <span className="viewer-mode-badge">
            <Rocket size={13} />
            {route.view === "published" ? tr(locale, "已发布版本", "Published version") : tr(locale, "当前保存版本", "Saved version")}
          </span>
          <strong>{sceneName}</strong>
        </div>
      )}
    </header>
    {pathTraceOpen && project && <PathTraceAuthorDialog locale={locale} models={project.models}
      sourceKey={`${project.id}/${activeScene?.id ?? ""}/${state.revision}`}
      getSnapshot={() => latestBindings.current.scenePersistence.makeSnapshot()}
      onClose={() => setPathTraceOpen(false)}/>}
    {drillGuideOpen && activeScene && <SceneDrillWizard
      locale={locale} sceneId={activeScene.id} sceneName={sceneName}
      sources={state.interactionTargetOptions} scenes={state.scenes.map((scene) => ({ id: scene.id, name: scene.name }))}
      cameras={state.cameraViews.map((view) => ({ id: view.id, name: view.name }))}
      interactions={state.sceneInteractions} onChange={state.setSceneInteractions}
      onPreview={(script) => void state.engine?.runInteractionScript(script, { test: true })}
      onClose={() => setDrillGuideOpen(false)}
    />}</>
  );
}
