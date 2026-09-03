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
  Settings,
  History,
  Languages,
  Layers3,
  LogOut,
  MoreHorizontal,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  ScanSearch,
  Search,
  Square,
  Trash2,
} from "lucide-react";
import type { CSSProperties } from "react";
import { SceneExportMenu } from "./SceneExportMenu";
import { translate as tr } from "../i18n";
import { ProjectDeliveryFlow } from "./SceneDeliveryWorkflow";
import type { SceneManagerController } from "./SceneManager";
import { SceneManagerDialogs } from "./SceneManagerDialogs";
import { UnifiedAssetLibraryPage } from "./UnifiedAssetLibraryPage";
import { sceneThumbnailItems } from "./sceneManagerPresentation";

export function SceneManagerView({ controller }: { controller: SceneManagerController }) {
  const {
    branding,
    busy,
    cloudBusySceneId,
    cloudConfigured,
    cloudError,
    cloudSceneLinks,
    cloudScenePolicies,
    copyLink,
    createShowcase,
    deliveryReviewOpen,
    dialogMode,
    isAdmin,
    locale,
    managerTab,
    name,
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
    onProjectChange,
    onPublish,
    onRenameProject,
    onSystem,
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

  return (
    <main className={`scene-manager-page ${managerTab === "assets" ? "asset-workspace-active" : ""}`}>
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
          <select value={project?.id ?? ""} onChange={(event) => onProjectChange(event.target.value)} aria-label={tr(locale, "当前项目", "Current project")}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <details>
            <summary aria-label={tr(locale, "项目管理", "Project management")} title={tr(locale, "项目管理", "Project management")}><MoreHorizontal size={15} /></summary>
            <div>
              <button onClick={onCreateProject}><Plus size={13} />{tr(locale, "新建项目", "New project")}</button>
              <button disabled={!project} onClick={onRenameProject}><Pencil size={13} />{tr(locale, "重命名项目", "Rename project")}</button>
              <button className="danger" disabled={!project} onClick={onDeleteProject}><Trash2 size={13} />{tr(locale, "删除项目", "Delete project")}</button>
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
          <button aria-label={tr(locale, "智能运营", "Intelligent operations")} title={tr(locale, "智能运营", "Intelligent operations")} disabled={!project} onClick={onOperationsCenter}>
            <Activity size={14} />
            <span>{tr(locale, "智能运营", "Operations")}</span>
          </button>
          <button aria-label={tr(locale, "AI 助手", "AI Assistant")} title={tr(locale, "AI 助手", "AI Assistant")} disabled={!project} onClick={onAiAssistant}>
            <Bot size={14} />
            <span>{tr(locale, "AI 助手", "AI Assistant")}</span>
          </button>
          <button aria-label={tr(locale, "模型优化", "Model optimization")} title={tr(locale, "模型优化", "Model optimization")} onClick={onOptimizer}>
            <Gauge size={14} />
            <span>{tr(locale, "模型优化", "Model optimization")}</span>
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
          <button aria-label={tr(locale, "切换语言", "Switch language")} title={tr(locale, "切换语言", "Switch language")} onClick={onLocaleToggle}>
            <Languages size={14} />
          </button>
          <button aria-label={`${tr(locale, "退出", "Sign out")} · ${userName}`} title={`${tr(locale, "退出", "Sign out")} · ${userName}`} onClick={onLogout}>
            <LogOut size={14} />
          </button>
        </nav>
      </header>

      <section className="manager-content">
        {(managerTab === "scenes" || managerTab === "topology") && <div className={`manager-project-bar contextual ${managerTab === "scenes" ? "scene-toolbar" : ""}`}>
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
                <option value="updated">{tr(locale, "最近更新", "Recently updated")}</option>
                <option value="name">{tr(locale, "按名称", "By name")}</option>
                <option value="objects">{tr(locale, "按对象数", "By object count")}</option>
              </select>
              <span className="manager-scene-count">{visibleScenes.length} / {scenes.length}</span>
              <i className="manager-toolbar-spacer" />
              <button type="button" className="button" onClick={onImport}>
                <FileUp size={15} />
                {tr(locale, "导入", "Import")}
              </button>
              <button type="button" className="button primary" onClick={openCreateDialog}>
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
                        {scene.models.some((item) => item.visible) || scene.primitives.some((item) => item.visible)
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
                        {scene.models.length + scene.primitives.length + scene.measurements.length + (scene.annotations?.length ?? 0)} {tr(locale, "个对象", "objects")}
                      </small>
                    </button>
                    <div className="scene-card-body">
                      <button type="button" className="scene-card-title" onClick={() => void onBrowse(scene)}>
                        {scene.name}
                      </button>
                      <div className="scene-card-meta">
                        <CalendarDays size={12} />
                        {tr(locale, "更新于", "Updated")} {new Date(scene.updatedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
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
                              setPublishTarget(scene);
                            }}
                          ><Rocket size={14} /></button>
                          <button
                            type="button"
                            disabled={!scene.publishedAt}
                            aria-label={tr(locale, "复制发布链接", "Copy published link")}
                            title={scene.publishedAt ? tr(locale, "复制链接", "Copy link") : tr(locale, "发布后可复制链接", "Publish before copying a link")}
                            onClick={() => scene.publishedAt && void copyLink(new URL(`/published/${encodeURIComponent(scene.id)}`, window.location.origin).href)}
                          ><Copy size={15} /></button>
                          <button type="button" aria-label={tr(locale, "重命名场景", "Rename scene")} title={tr(locale, "重命名", "Rename")} onClick={() => openRenameDialog(scene)}><FilePenLine size={15} /></button>
                          <details className="scene-card-more">
                            <summary aria-label={tr(locale, "更多场景操作", "More scene actions")} title={tr(locale, "更多", "More")}><MoreHorizontal size={15} /></summary>
                            <div className="scene-card-more-menu">
                              {scene.publishedAt && <button onClick={() => void onBrowsePublished(scene)}><Eye size={13} />{tr(locale, "查看发布版", "View published")}</button>}
                              {scene.publishedAt && <button onClick={() => void openVersions(scene)}><History size={13} />{tr(locale, "版本历史", "Version history")}</button>}
                              {scene.publishedAt && <button onClick={() => void onUnpublish(scene)}><Square size={12} />{tr(locale, "撤回发布", "Unpublish")}</button>}
                              <button onClick={() => void onCopy(scene)}><Copy size={13} />{tr(locale, "复制场景", "Duplicate scene")}</button>
                              {cloudSceneLinks[scene.id] && <button onClick={() => void copyLink(cloudSceneLinks[scene.id]!)}><CloudCog size={13} />{tr(locale, "复制云渲染链接", "Copy cloud link")}</button>}
                              {isAdmin && scene.publishedAt && (
                                <button role="switch" aria-checked={Boolean(cloudScenePolicies[scene.id])} disabled={!cloudConfigured || cloudBusySceneId === scene.id} onClick={() => void toggleSceneCloudRender(scene.id, !cloudScenePolicies[scene.id])}>
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
                <h2>{tr(locale, "还没有场景", "No scenes yet")}</h2>
                <p>{tr(locale, "新建项目内容，默认从空白二维页面开始。", "Create project content starting from a blank 2D page.")}</p>
                <button className="button primary" onClick={openCreateDialog}>
                  <Plus size={17} />
                  {tr(locale, "新建第一个场景", "Create first scene")}
                </button>
              </div>
            )}
          </>
        )}

        {managerTab === "examples" && (
          <section className="manager-showcase" aria-label={tr(locale, "内置综合案例", "Built-in showcase")}>
            <div className="manager-showcase-icon">
              <Factory size={25} />
            </div>
            <div className="manager-showcase-copy">
              <span className="eyebrow">EDITABLE SHOWCASE</span>
              <strong>{tr(locale, "智造园区综合案例", "Smart industrial campus")}</strong>
              <p>
                {tr(
                  locale,
                  "一键创建 4K 看板、四级 2D/3D 场景、楼层与部件拆解、巡检视角、AGV、图片/视频/实时监控，以及直连 HTTP/WebSocket 数据。",
                  "Create an editable 4K dashboard, four connected 2D/3D levels, floor and component decomposition, inspection cameras, AGVs, media, monitoring, and direct HTTP/WebSocket data.",
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
                      <Network size={26} />
                      <span>{topology.nodes.length}</span>
                      <i />
                      <i />
                      <i />
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
      </section>


      <SceneManagerDialogs controller={controller} />
    </main>
  );
}
