import { CloudRenderQualityEntry } from "./CloudRenderQualityDialog";
import {
  Activity,
  BookOpen,
  Bot,
  Box,
  CalendarDays,
  CloudCog,
  Copy,
  Database,
  Eye,
  Factory,
  FileUp,
  FilePenLine,
  Gauge,
  Route,
  Settings,
  History,
  Languages,
  Layers3,
  LogOut,
  MoreHorizontal,
  Network,
  Palette,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  ScanSearch,
  Search,
  Square,
  Trash2,
  TriangleAlert,
  WandSparkles,
  X,
} from "lucide-react";
import { lazy, Suspense, type CSSProperties, type MouseEvent } from "react";
import { SceneExportMenu } from "./SceneExportMenu";
import { translate as tr } from "../i18n";
import { ProjectDeliveryFlow } from "./SceneDeliveryWorkflow";
import type { SceneManagerController } from "./SceneManager";
import { SceneManagerDialogs } from "./SceneManagerDialogs";
import { UnifiedAssetLibraryPage } from "./UnifiedAssetLibraryPage";
import { sceneThumbnailItems } from "./sceneManagerPresentation";
import { TopologyMiniature } from "./TopologyMiniature";
import { ManagerDirectoryStatus, managerDirectoryIssue } from "./ManagerDirectoryStatus";

const ProjectTransferDialog = lazy(() => import("./ProjectTransferDialog").then(module => ({ default: module.ProjectTransferDialog })));

export function SceneManagerView({ controller }: { controller: SceneManagerController }) {
  const {
    directory,
    branding,
    busy,
    cloudBusySceneId,
    cloudConfigured,
    cloudError,
    cloudSceneLinks,
    cloudScenePolicies,
    copyLink,
    copyNotice,
    createShowcase,
    deliveryReviewOpen,
    dialogMode,
    isAdmin,
    locale,
    managerTab,
    name,
    navigationNotice,
    onDismissNavigationNotice,
    onAiAssistant,
    onBrowse,
    onBrowsePublished,
    onCloudRender,
    onCopy,
    onCreateProject,
    onCreateTopology,
    onDataCenter,
    onDelete,
    onDeleteProject,
    onDocs,
    onExportFbx,
    onExportGlb,
    onExportLoose,
    onExportSingle,
    onImport,
    onLocaleToggle,
    onLogout,
    onOpen,
    onOpenBehavior,
    onOpenSimulation,
    onOpenTopology,
    onOperationsCenter,
    onOptimizer,
    onParametric,
    onProjectChange,
    onPublish,
    onRenameProject,
    onSystem,
    onBranding,
    onUnpublish,
    onVisionCenter,
    openCreateDialog,
    openRenameDialog,
    openVersions,
    project,
    projects,
    publicationVersions,
    publishMode,
    publishPerformance,
    publishTarget,
    restoreVersion,
    scenes,
    sceneSearch,
    sceneSort,
    sceneStatusFilter,
    setCloudError,
    setDeliveryReviewOpen,
    setDialogMode,
    setManagerTab,
    setName,
    setSceneSearch,
    setSceneSort,
    setSceneStatusFilter,
    setPublishMode,
    setPublishPerformance,
    setPublishClientTarget,
    setPublishTarget,
    setVersionTarget,
    showcaseBusy,
    showcaseExists,
    sortedScenes,
    submitPublish,
    submitSceneDialog,
    toggleSceneCloudRender,
    topologies,
    userName,
    versionBusy,
    versionTarget,
    visibleScenes,
  } = controller;

  // V3-P3 预防提示：同名场景计数，仅提示不自动删除（数据治理需用户确认）。
  const duplicateSceneNames = new Map<string, number>();
  for (const scene of sortedScenes) duplicateSceneNames.set(scene.name, (duplicateSceneNames.get(scene.name) ?? 0) + 1);
  const directoryIssue = managerDirectoryIssue(directory, Boolean(project));
  const projectDirectoryBlocked = directory !== undefined && directory.projects.phase !== "ready";
  function projectAction(event: MouseEvent<HTMLButtonElement>, action: () => void) {
    const menu = event.currentTarget.closest("details");
    if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
    action();
  }

  return (
    <main className={`scene-manager-page ${managerTab === "assets" ? "asset-workspace-active" : ""}`}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        const menus = [...event.currentTarget.querySelectorAll<HTMLDetailsElement>(".scene-card-more[open], .manager-project-switch details[open]")];
        const menu = menus.find((item) => item.contains(event.target as Node)) ?? menus.at(-1);
        if (!menu) return;
        event.preventDefault(); event.stopPropagation(); menu.open = false;
        menu.querySelector<HTMLElement>("summary")?.focus();
      }}
      onPointerDownCapture={(event) => {
        event.currentTarget.querySelectorAll<HTMLDetailsElement>(".scene-card-more[open], .manager-project-switch details[open]").forEach((menu) => {
          if (!menu.contains(event.target as Node)) menu.open = false;
        });
      }}>
      <header className="manager-header">
        <div className="manager-brand">
          <span>
            {/* 管理中心的窄位使用方形应用图标，避免横向字标被裁切。 */}
            <img src={branding.iconUrl} alt={branding.systemName} />
          </span>
          <div>
            <h1>{branding.systemName}</h1>
            <small>{tr(locale, "项目工作台", "Project workspace")}</small>
          </div>
        </div>
        <div className="manager-project-switch">
          <select disabled={projectDirectoryBlocked} value={project?.id ?? ""} onChange={(event) => onProjectChange(event.target.value)} aria-label={tr(locale, "当前项目", "Current project")}>
            {!project && <option value="">{projectDirectoryBlocked ? tr(locale, "项目目录未就绪", "Directory not ready") : tr(locale, "暂无项目", "No projects")}</option>}
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <details>
            <summary aria-label={tr(locale, "项目管理", "Project management")} title={tr(locale, "项目管理", "Project management")}><MoreHorizontal size={15} /></summary>
            <div>
              <button disabled={projectDirectoryBlocked} title={projectDirectoryBlocked ? tr(locale, "请先重新读取项目目录", "Reload the project directory first") : undefined} onClick={event => projectAction(event, onCreateProject)}><Plus size={13} />{tr(locale, "新建项目", "New project")}</button>
              <button disabled={!project || projectDirectoryBlocked} onClick={event => projectAction(event, onRenameProject)}><Pencil size={13} />{tr(locale, "重命名项目", "Rename project")}</button>
              <button disabled={projectDirectoryBlocked} onClick={event => projectAction(event, () => controller.setProjectTransferOpen(true))}><FileUp size={13} />{tr(locale, "项目交付", "Project delivery")}</button>
              <button className="danger" disabled={!project || projectDirectoryBlocked} onClick={event => projectAction(event, onDeleteProject)}><Trash2 size={13} />{tr(locale, "删除项目", "Delete project")}</button>
            </div>
          </details>
        </div>
        <nav className="manager-primary-nav" aria-label={tr(locale, "一级工作区", "Primary workspaces")}>
          <button aria-label={tr(locale, "项目场景", "Project scenes")} title={tr(locale, "项目场景", "Project scenes")} className={managerTab === "scenes" ? "active" : ""} onClick={() => setManagerTab("scenes")}>
            <Layers3 size={16} />
            <span>{tr(locale, "项目场景", "Project scenes")}</span>
          </button>
          <button aria-label={tr(locale, "资源", "Assets")} title={tr(locale, "资源", "Assets")} className={managerTab === "assets" ? "active" : ""} disabled={!project} onClick={() => setManagerTab("assets")}>
            <Box size={16} />
            <span>{tr(locale, "资源", "Assets")}</span>
          </button>
          <button aria-label={tr(locale, "拓扑", "Topology")} title={tr(locale, "拓扑", "Topology")} className={managerTab === "topology" ? "active" : ""} disabled={!project} onClick={() => setManagerTab("topology")}>
            <Network size={16} />
            <span>{tr(locale, "拓扑", "Topology")}</span>
          </button>
          <button aria-label={tr(locale, "示例场景", "Example scenes")} title={tr(locale, "示例场景", "Example scenes")} className={managerTab === "examples" ? "active" : ""} onClick={() => setManagerTab("examples")}>
            <Factory size={16} />
            <span>{tr(locale, "示例场景", "Example scenes")}</span>
          </button>
        </nav>
        <nav className="manager-capability-nav" aria-label={tr(locale, "平台能力", "Platform capabilities")}>
          <button aria-label={tr(locale, "数据中心", "Data center")} title={tr(locale, "数据中心", "Data center")} disabled={!project} onClick={onDataCenter}>
            <Database size={14} />
            <span>{tr(locale, "数据", "Data")}</span>
          </button>
          <button aria-label={tr(locale, "视觉中心", "Vision center")} title={tr(locale, "视觉中心", "Vision center")} disabled={!project} onClick={onVisionCenter}>
            <ScanSearch size={14} />
            <span>{tr(locale, "视觉", "Vision")}</span>
          </button>
          <button aria-label={tr(locale, "智能运营", "Intelligent operations")} title={tr(locale, "智能运营", "Intelligent operations")} disabled={!project} onClick={() => onOperationsCenter()}>
            <Activity size={14} />
            <span>{tr(locale, "智能运营", "Operations")}</span>
          </button>
          <button aria-label={tr(locale, "AI 助手", "AI Assistant")} title={tr(locale, "AI 助手", "AI Assistant")} disabled={!project} onClick={onAiAssistant}>
            <Bot size={14} />
            <span>{tr(locale, "AI 助手", "AI Assistant")}</span>
          </button>
          <button aria-label={tr(locale, "模型优化", "Model optimization")} title={tr(locale, "模型优化", "Model optimization")} onClick={() => onOptimizer()}>
            <Gauge size={14} />
            <span>{tr(locale, "模型优化", "Model optimization")}</span>
          </button>
          <button aria-label={tr(locale, "参数化生成", "Parametric generation")} title={tr(locale, "参数化生成", "Parametric generation")} disabled={!project} onClick={onParametric}>
            <WandSparkles size={14} />
            <span>{tr(locale, "参数化", "Parametric")}</span>
          </button>
          {isAdmin && (
            <button aria-label={tr(locale, "云渲染设置", "Cloud settings")} title={tr(locale, "云渲染设置", "Cloud settings")} disabled={!project} onClick={onCloudRender}>
              <CloudCog size={14} />
              <span>{tr(locale, "云渲染设置", "Cloud settings")}</span>
            </button>
          )}
          <button aria-label={tr(locale, "文档", "Docs")} title={tr(locale, "文档", "Docs")} onClick={onDocs}>
            <BookOpen size={14} />
            <span>{tr(locale, "文档", "Docs")}</span>
          </button>
        </nav>
        <nav className="manager-utility-nav" aria-label={tr(locale, "系统操作", "System actions")}>
          {isAdmin && (
            <button title={tr(locale, "设置", "Settings")} aria-label={tr(locale, "设置", "Settings")} onClick={onSystem}>
              <Settings size={15} />
            </button>
          )}
          {isAdmin && (
            <button title={tr(locale, "品牌设置", "Brand settings")} aria-label={tr(locale, "品牌设置", "Brand settings")} onClick={onBranding}>
              <Palette size={15} />
            </button>
          )}
          <button aria-label={tr(locale, "切换语言", "Switch language")} title={tr(locale, "切换语言", "Switch language")} onClick={onLocaleToggle}>
            <Languages size={14} />
          </button>
          <button aria-label={`${tr(locale, "退出", "Sign out")} · ${userName}`} title={`${tr(locale, "退出", "Sign out")} · ${userName}`} onClick={onLogout}>
            <LogOut size={14} />
          </button>
        </nav>
      </header>

      <section className="manager-content">
        {navigationNotice && <div className="manager-navigation-notice" role="status">
          <span>{navigationNotice}</span>
          <button aria-label={tr(locale, "关闭页面提示", "Dismiss page notice")} onClick={onDismissNavigationNotice}><X size={16} /></button>
        </div>}
        {copyNotice && <p className="manager-copy-notice" role="status">{copyNotice}</p>}
        {directoryIssue ? <ManagerDirectoryStatus issue={directoryIssue} locale={locale} onRetry={() => directory?.retry()} /> : <>
        {project && (managerTab === "scenes" || managerTab === "topology") && <div className={`manager-project-bar contextual ${managerTab === "scenes" ? "scene-toolbar" : ""}`}>
          {managerTab === "scenes" && (
            <>
              <label className="manager-scene-search" aria-label={tr(locale, "搜索场景", "Search scenes")} title={tr(locale, "搜索场景", "Search scenes")}>
                <Search size={14} />
                <input
                  aria-label={tr(locale, "搜索场景", "Search scenes")}
                  value={sceneSearch}
                  placeholder={tr(locale, "搜索场景名称", "Search scene names")}
                  onChange={(event) => setSceneSearch(event.target.value)}
                />
              </label>
              <select
                aria-label={tr(locale, "场景状态", "Scene status")}
                value={sceneStatusFilter}
                onChange={(event) => setSceneStatusFilter(event.target.value as typeof sceneStatusFilter)}
              >
                <option value="all">{tr(locale, "全部状态", "All statuses")}</option>
                <option value="published">{tr(locale, "已发布", "Published")}</option>
                <option value="draft">{tr(locale, "未发布", "Unpublished")}</option>
              </select>
              <select
                aria-label={tr(locale, "场景排序", "Sort scenes")}
                value={sceneSort}
                onChange={(event) => setSceneSort(event.target.value as typeof sceneSort)}
              >
                <option value="updated">{tr(locale, "最近变更", "Recently changed")}</option>
                <option value="name">{tr(locale, "按名称", "By name")}</option>
                <option value="objects">{tr(locale, "按对象数", "By object count")}</option>
              </select>
              <span className="manager-scene-count">{visibleScenes.length} / {scenes.length}</span>
              <i className="manager-toolbar-spacer" />
              <button type="button" className="button" onClick={onImport}>
                <FileUp size={15} />
                {tr(locale, "导入", "Import")}
              </button>
              <button type="button" className={scenes.length > 0 ? "button primary" : "button"} onClick={openCreateDialog}>
                <Plus size={16} />
                {tr(locale, "新建场景", "New scene")}
              </button>
            </>
          )}
          {managerTab === "topology" && (
            <button className="button primary" onClick={onCreateTopology}>
              <Plus size={16} />
              {tr(locale, "新建拓扑", "New topology")}
            </button>
          )}
        </div>}
        {project && managerTab === "scenes" && (
          <ProjectDeliveryFlow
            locale={locale}
            project={project}
            scenes={scenes}
            onData={onDataCenter}
            onAssets={() => setManagerTab("assets")}
            onDesign={() => setManagerTab("scenes")}
            onLinkage={() => {
              const linked = sortedScenes.find((scene) => (scene.dataBindings?.length ?? 0) + (scene.interactions?.length ?? 0) > 0) ?? sortedScenes[0];
              if (linked) void onOpen(linked);
              else setManagerTab("scenes");
            }}
            onBehavior={() => {
              const linked = sortedScenes.find((scene) => (scene.interactions?.length ?? 0) > 0) ?? sortedScenes[0];
              if (linked) void (onOpenBehavior ? onOpenBehavior(linked) : onOpen(linked));
              else setManagerTab("scenes");
            }}
            onSimulation={() => {
              const linked = sortedScenes.find((scene) => Boolean(scene.physics) || Boolean(scene.animation)) ?? sortedScenes[0];
              if (linked) void (onOpenSimulation ? onOpenSimulation(linked) : onOpen(linked));
              else setManagerTab("scenes");
            }}
            onValidate={() => setDeliveryReviewOpen(true)}
            onPublish={() => setManagerTab("scenes")}
          />
        )}

        {managerTab === "scenes" && (
          <>
            {cloudError && (
              <div className="project-cloud-error">
                <CloudCog size={13} />
                <span>{cloudError}</span>
                <button onClick={() => setCloudError(undefined)} aria-label={tr(locale, "关闭提示", "Dismiss")}>
                  ×
                </button>
              </div>
            )}

            {visibleScenes.length > 0 ? (
              <div className="scene-card-grid">
                {visibleScenes.map((scene) => (
                  <article className="scene-card" key={scene.id}>
                    <button type="button" className="scene-card-preview" aria-label={`${tr(locale, "预览场景", "Preview scene")} · ${scene.name}`} title={tr(locale, "预览场景", "Preview scene")} onClick={() => void onBrowse(scene)}>
                      {scene.publishedAt && (
                        <span className="scene-published-badge">
                          <Rocket size={11} />
                          {tr(locale, "已发布", "Published")}
                        </span>
                      )}
                      <span
                        className="scene-card-thumbnail"
                        aria-hidden="true"
                        style={{ "--scene-thumbnail-background": scene.environment?.backgroundColor ?? "#11191d" } as CSSProperties}
                      >
                        {scene.thumbnail
                          ? <img className="scene-card-thumbnail-image" src={scene.thumbnail} alt="" draggable={false} />
                          : scene.models.some((item) => item.visible) || scene.primitives.some((item) => item.visible)
                            ? sceneThumbnailItems(scene).map((item) => (
                                <i
                                  key={`${item.kind}:${item.id}`}
                                  className={`scene-card-thumbnail-item kind-${item.kind}`}
                                  style={{
                                    "--scene-thumbnail-color": item.color,
                                    left: `${item.left}%`,
                                    top: `${item.top}%`,
                                  } as CSSProperties}
                                />
                              ))
                            : <Layers3 className="scene-card-thumbnail-empty" size={32} />}
                      </span>
                      <small>
                        {scene.models.length + scene.primitives.length + scene.measurements.length + (scene.annotations?.length ?? 0)} {tr(locale, "个对象", scene.models.length + scene.primitives.length + scene.measurements.length + (scene.annotations?.length ?? 0) === 1 ? "object" : "objects")}
                      </small>
                    </button>
                    <div className="scene-card-body">
                      <button type="button" className="scene-card-title" onClick={() => void onBrowse(scene)}>
                        {scene.name}
                        {(duplicateSceneNames.get(scene.name) ?? 0) > 1 && (
                          <span
                            className="scene-card-duplicate"
                            title={tr(locale, `同名场景有 ${duplicateSceneNames.get(scene.name)} 个，请核查是否为重复数据`, `${duplicateSceneNames.get(scene.name)} scenes share this name; verify whether they are duplicates`)}
                          >
                            <TriangleAlert size={11} />
                          </span>
                        )}
                      </button>
                      <div className="scene-card-meta" title={tr(locale, "最近变更包括内容保存、发布及撤回发布，不仅是模型内容修改", "Last change includes content saves, publishing and unpublishing, not only model edits")}>
                        <CalendarDays size={12} />
                        {tr(locale, "变更于", "Changed")} {new Date(scene.updatedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                      </div>
                      <div className="scene-card-footer">
                        <span>
                          {scene.measurements.length} {tr(locale, "条测量", "measurements")} · {scene.annotations?.length ?? 0} {tr(locale, "个标签", "annotations")}
                        </span>
                        <div className="scene-card-actions">
                          <button type="button" className="primary" aria-label={tr(locale, "预览场景", "Preview scene")} title={tr(locale, "预览", "Preview")} onClick={() => void onBrowse(scene)}><Eye size={15} /></button>
                          <button type="button" aria-label={tr(locale, "编辑场景", "Edit scene")} title={tr(locale, "编辑", "Edit")} onClick={() => void onOpen(scene)}><Pencil size={15} /></button>
                          <button
                            type="button"
                            aria-label={scene.publishedAt ? tr(locale, "重新发布场景", "Republish scene") : tr(locale, "发布场景", "Publish scene")}
                            title={scene.publishedAt ? tr(locale, "重新发布", "Republish") : tr(locale, "发布", "Publish")}
                            onClick={() => {
                              setPublishMode(scene.publicationMode ?? "webgl");
                              setPublishPerformance(scene.publicationPerformance ?? "standard");
                              setPublishClientTarget("none");
                              setPublishTarget(scene);
                            }}
                          ><Rocket size={14} /></button>
                          {scene.publishedAt && (
                            <button
                              type="button"
                              aria-label={tr(locale, "版本历史", "Version history")}
                              title={tr(locale, "版本历史", "Version history")}
                              onClick={() => void openVersions(scene)}
                            ><History size={14} /></button>
                          )}
                          <button
                            type="button"
                            aria-label={tr(locale, "复制场景", "Duplicate scene")}
                            title={tr(locale, "复制", "Duplicate")}
                            onClick={() => void onCopy(scene)}
                          ><Copy size={14} /></button>
                          <button
                            type="button"
                            aria-label={tr(locale, "重命名场景", "Rename scene")}
                            title={tr(locale, "重命名", "Rename")}
                            onClick={() => openRenameDialog(scene)}
                          ><FilePenLine size={14} /></button>
                          <details className="scene-card-more">
                            <summary role="button" aria-label={tr(locale, "更多场景操作", "More scene actions")} title={tr(locale, "更多", "More")}><MoreHorizontal size={15} /></summary>
                            <div className="scene-card-more-menu">
                              {scene.publishedAt && <button onClick={() => void onBrowsePublished(scene)}><Eye size={13} />{tr(locale, "查看发布版", "View published")}</button>}
                              {scene.publishedAt && <button onClick={(event) => { const menu = event.currentTarget.closest("details"); if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); } void copyLink(new URL(`/published/${encodeURIComponent(scene.id)}`, window.location.origin).href); }}><Copy size={13} />{tr(locale, "复制发布链接", "Copy published link")}</button>}
                              {scene.publishedAt && <button onClick={() => void onUnpublish(scene)}><Square size={12} />{tr(locale, "撤回发布", "Unpublish")}</button>}
                              {cloudSceneLinks[scene.id] && <button onClick={() => void copyLink(cloudSceneLinks[scene.id]!)}><CloudCog size={13} />{tr(locale, "复制云渲染链接", "Copy cloud link")}</button>}
                              {isAdmin && scene.publishedAt && <CloudRenderQualityEntry sceneId={scene.id} locale={locale} />}
                              {isAdmin && scene.publishedAt && (
                                <button role="switch" title={!cloudConfigured ? tr(locale, "云渲染未配置或服务不可用，请在云渲染设置中检查", "Cloud rendering is not configured or unavailable; check Cloud settings") : undefined} aria-checked={Boolean(cloudScenePolicies[scene.id])} disabled={!cloudConfigured || cloudBusySceneId === scene.id} onClick={() => void toggleSceneCloudRender(scene.id, !cloudScenePolicies[scene.id])}>
                                  <CloudCog size={13} />
                                  {cloudBusySceneId === scene.id ? tr(locale, "云渲染保存中", "Saving cloud rendering") : cloudScenePolicies[scene.id] ? tr(locale, "关闭云渲染", "Disable cloud rendering") : tr(locale, "开启云渲染", "Enable cloud rendering")}
                                </button>
                              )}
                              <div className="scene-card-more-export">
                                <SceneExportMenu locale={locale} onExportLoose={() => onExportLoose(scene)} onExportSingle={() => void onExportSingle(scene)} onExportGlb={() => void onExportGlb(scene)} onExportFbx={() => void onExportFbx(scene)} />
                              </div>
                              <button className="danger" onClick={() => void onDelete(scene)}><Trash2 size={13} />{tr(locale, "删除场景", "Delete scene")}</button>
                            </div>
                          </details>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            ) : scenes.length > 0 ? (
              <div className="manager-empty compact">
                <Search size={34} />
                <h2>{tr(locale, "没有匹配的场景", "No matching scenes")}</h2>
                <p>{tr(locale, "清除搜索词或切换状态筛选。", "Clear the query or change the status filter.")}</p>
                <button className="button" onClick={() => { setSceneSearch(""); setSceneStatusFilter("all"); }}>
                  {tr(locale, "清除筛选", "Clear filters")}
                </button>
              </div>
            ) : (
              <div className="manager-empty">
                <Box size={42} />
                <h2>{project ? tr(locale, "还没有场景", "No scenes yet") : tr(locale, "还没有项目", "No projects yet")}</h2>
                <p>{project ? tr(locale, "新建项目内容，默认从空白二维页面开始。", "Create project content starting from a blank 2D page.") : tr(locale, "先创建一个项目，再添加场景和资源。", "Create a project before adding scenes and assets.")}</p>
                <button className="button primary" onClick={project ? openCreateDialog : onCreateProject}>
                  <Plus size={17} />
                  {project ? tr(locale, "新建第一个场景", "Create first scene") : tr(locale, "新建第一个项目", "Create first project")}
                </button>
              </div>
            )}
          </>
        )}

        {managerTab === "examples" && (
          <section className="manager-showcase-grid" aria-label={tr(locale, "内置综合案例", "Built-in showcases")}>
            <article className="manager-showcase">
              <div className="manager-showcase-icon">
                <Factory size={25} />
              </div>
              <div className="manager-showcase-copy">
                <span className="eyebrow">EDITABLE SHOWCASE · 01</span>
                <strong>{tr(locale, "智造园区综合案例", "Smart industrial campus")}</strong>
                <p>
                  {tr(
                    locale,
                    "一键创建 4K 看板、四级 2D/3D 场景、楼层与部件拆解、巡检视角、AGV、图片/视频/实时监控，以及直连 HTTP/WebSocket 数据。",
                    "Create an editable 4K dashboard, four connected 2D/3D levels, inspection cameras, AGVs, media, monitoring, and direct HTTP/WebSocket data.",
                  )}
                </p>
              </div>
              <div className="manager-showcase-tags">
                <span>4K 2D</span>
                <span>LIVE 3D</span>
                <span>AGV</span>
                <span>HTTP / WS</span>
              </div>
              <button className="button primary manager-showcase-action" disabled={!project || showcaseBusy} onClick={() => void createShowcase()}>
                {showcaseBusy ? <RefreshCw className="spin" size={16} /> : showcaseExists ? <Eye size={16} /> : <Plus size={16} />}
                {showcaseBusy
                  ? tr(locale, "正在打开…", "Opening…")
                  : showcaseExists
                    ? tr(locale, "打开已创建案例", "Open existing showcase")
                    : tr(locale, "创建可编辑案例", "Create editable showcase")}
              </button>
            </article>
            <article className="manager-showcase manager-showcase-secondary">
              <div className="manager-showcase-icon">
                <Gauge size={25} />
              </div>
              <div className="manager-showcase-copy">
                <span className="eyebrow">OPERATIONS SHOWCASE · 02</span>
                <strong>{tr(locale, "设备运维与能效案例", "Operations and energy case")}</strong>
                <p>
                  {tr(
                    locale,
                    "从设备台账、实时指标、告警诊断到维修工单，展示工业数据如何进入可追溯的运维流程，并可继续编辑数据、规则与证据。",
                    "Trace industrial data from equipment records and live metrics to diagnosis and maintenance work orders, with editable data, rules, and evidence.",
                  )}
                </p>
              </div>
              <div className="manager-showcase-tags">
                <span>ASSET LEDGER</span>
                <span>DIAGNOSIS</span>
                <span>ENERGY</span>
                <span>EVIDENCE</span>
              </div>
              <button className="button manager-showcase-action" disabled={!project} onClick={() => onOperationsCenter()}>
                <Activity size={16} />
                {tr(locale, "打开运维案例", "Open operations case")}
              </button>
            </article>
            <article className="manager-showcase manager-showcase-tertiary">
              <div className="manager-showcase-icon">
                <Route size={25} />
              </div>
              <div className="manager-showcase-copy">
                <span className="eyebrow">LOGISTICS SIMULATION · 03</span>
                <strong>{tr(locale, "仓储物流与路径仿真案例", "Warehouse logistics and routing")}</strong>
                <p>
                  {tr(
                    locale,
                    "从订单波次、库位容量到 AGV 路径与拥堵风险，直接编辑工况并运行仿真，查看吞吐、等待和设备利用率证据。",
                    "Edit order waves, storage capacity, AGV routes, and congestion conditions, then run a simulation with throughput, wait-time, and utilization evidence.",
                  )}
                </p>
              </div>
              <div className="manager-showcase-tags">
                <span>AGV ROUTING</span>
                <span>WHAT-IF</span>
                <span>THROUGHPUT</span>
                <span>EDITABLE</span>
              </div>
              <button className="button manager-showcase-action" disabled={!project} onClick={() => onOperationsCenter("logistics")}>
                <Route size={16} />
                {tr(locale, "打开物流仿真", "Open logistics simulation")}
              </button>
            </article>
          </section>
        )}

        {managerTab === "assets" && <UnifiedAssetLibraryPage controller={controller} />}

        {managerTab === "topology" && (
          <section className="manager-page-panel manager-topology-page">
            {topologies.length ? (
              <div className="manager-topology-grid">
                {topologies.map(({ applicationId, applicationName, topology }) => (
                  <article key={`${applicationId}:${topology.id}`}>
                    <button
                      className="manager-topology-preview"
                      aria-label={tr(locale, `打开拓扑 · ${topology.name}`, `Open topology · ${topology.name}`)}
                      title={tr(locale, `打开拓扑 · ${topology.name}`, `Open topology · ${topology.name}`)}
                      onClick={() => onOpenTopology(applicationId, topology.id)}
                    >
                      <TopologyMiniature topology={topology} />
                      <span>{topology.nodes.length}</span>
                    </button>
                    <div>
                      <strong>{topology.name}</strong>
                      <small>
                        {applicationName} · {topology.nodes.length} {tr(locale, "个节点", "nodes")} · {topology.edges.length} {tr(locale, "条连线", "edges")}
                      </small>
                    </div>
                    <button className="button" onClick={() => onOpenTopology(applicationId, topology.id)}>
                      <Pencil size={13} />
                      {tr(locale, "打开编辑", "Open editor")}
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="manager-empty">
                <Network size={42} />
                <h2>{tr(locale, "还没有拓扑", "No topologies yet")}</h2>
                <p>
                  {tr(
                    locale,
                    "拓扑是项目级可复用资源，可在二维页面中插入并绑定数据。",
                    "Topologies are reusable project resources that can be inserted into 2D pages and bound to data.",
                  )}
                </p>
                <button className="button primary" onClick={onCreateTopology}>
                  <Plus size={17} />
                  {tr(locale, "新建第一个拓扑", "Create first topology")}
                </button>
              </div>
            )}
          </section>
        )}
        </>}
      </section>


      <SceneManagerDialogs controller={controller} />
      {controller.projectTransferOpen && <Suspense fallback={null}><ProjectTransferDialog project={project} locale={locale}
        onClose={() => controller.setProjectTransferOpen(false)} onImported={value => controller.onProjectImported ? controller.onProjectImported(value) : onProjectChange(value.id)} /></Suspense>}
    </main>
  );
}
