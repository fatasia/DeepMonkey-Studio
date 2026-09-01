import {
  Activity,
  AlertTriangle,
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
  Gauge,
  HeartHandshake,
  History,
  Languages,
  Layers3,
  LogOut,
  Network,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Rocket,
  ScanSearch,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { SceneExportMenu } from "./SceneExportMenu";
import { translate as tr } from "../i18n";
import { ProjectDeliveryFlow } from "./SceneDeliveryWorkflow";
import type { SceneManagerController } from "./SceneManager";
import { SceneManagerDialogs } from "./SceneManagerDialogs";
import { UnifiedAssetLibraryPage } from "./UnifiedAssetLibraryPage";

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
    enableProjectCloudRender,
    isAdmin,
    locale,
    managerTab,
    name,
    onAiAssistant,
    onCloudRender,
    onConnectionStatus,
    onCopy,
    onCreateProject,
    onCreateTopology,
    onCredits,
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
    projectCloudBusy,
    projects,
    publicationVersions,
    publishMode,
    publishPerformance,
    publishTarget,
    restoreVersion,
    scenes,
    setCloudError,
    setDeliveryReviewOpen,
    setDialogMode,
    setManagerTab,
    setName,
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
            <strong>{branding.systemName}</strong>
            <small>{tr(locale, "项目工作台", "Project workspace")}</small>
          </div>
        </div>
        <nav className="manager-primary-nav" aria-label={tr(locale, "一级工作区", "Primary workspaces")}>
          <button className={managerTab === "scenes" ? "active" : ""} onClick={() => setManagerTab("scenes")}>
            <Layers3 size={16} />
            {tr(locale, "项目场景", "Project scenes")}
          </button>
          <button className={managerTab === "assets" ? "active" : ""} disabled={!project} onClick={() => setManagerTab("assets")}>
            <Box size={16} />
            {tr(locale, "资源库", "Assets")}
          </button>
          <button className={managerTab === "topology" ? "active" : ""} disabled={!project} onClick={() => setManagerTab("topology")}>
            <Network size={16} />
            {tr(locale, "拓扑", "Topology")}
          </button>
          <button className={managerTab === "examples" ? "active" : ""} onClick={() => setManagerTab("examples")}>
            <Factory size={16} />
            {tr(locale, "示例场景", "Example scenes")}
          </button>
        </nav>
        <nav className="manager-capability-nav" aria-label={tr(locale, "平台能力", "Platform capabilities")}>
          <button disabled={!project} onClick={onDataCenter}>
            <Database size={14} />
            {tr(locale, "数据", "Data")}
          </button>
          <button disabled={!project} onClick={onVisionCenter}>
            <ScanSearch size={14} />
            {tr(locale, "视觉", "Vision")}
          </button>
          <button disabled={!project} onClick={onOperationsCenter}>
            <Activity size={14} />
            {tr(locale, "智能运营", "Operations")}
          </button>
          <button disabled={!project} onClick={onAiAssistant}>
            <Bot size={14} />
            {tr(locale, "AI 助手", "AI Assistant")}
          </button>
          <button onClick={onOptimizer}>
            <Gauge size={14} />
            {tr(locale, "优化", "Optimize")}
          </button>
          {isAdmin && (
            <button disabled={!project} onClick={onCloudRender}>
              <CloudCog size={14} />
              {tr(locale, "云渲染设置", "Cloud settings")}
            </button>
          )}
          <button onClick={onDocs}>
            <BookOpen size={14} />
            {tr(locale, "文档", "Docs")}
          </button>
        </nav>
        <nav className="manager-utility-nav" aria-label={tr(locale, "系统操作", "System actions")}>
          {isAdmin && (
            <button title={tr(locale, "系统管理", "System administration")} onClick={onSystem}>
              <ShieldCheck size={14} />
            </button>
          )}
          <button title={tr(locale, "切换语言", "Switch language")} onClick={onLocaleToggle}>
            <Languages size={14} />
          </button>
          <button title={tr(locale, "连接与实时数据", "Connections and live data")} onClick={onConnectionStatus}>
            <Radio size={14} />
          </button>
          <button title={tr(locale, "致谢", "Credits")} onClick={onCredits}>
            <HeartHandshake size={14} />
          </button>
          <button title={`${tr(locale, "退出", "Sign out")} · ${userName}`} onClick={onLogout}>
            <LogOut size={14} />
          </button>
        </nav>
      </header>

      <section className="manager-content">
        <div className="manager-project-bar">
          <select value={project?.id ?? ""} onChange={(event) => onProjectChange(event.target.value)} aria-label={tr(locale, "项目", "Project")}>
            {projects.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <button className="button" onClick={onCreateProject}>
            <Plus size={15} />
            {tr(locale, "新建项目", "New project")}
          </button>
          <button className="button" disabled={!project} onClick={onRenameProject}>
            <Pencil size={14} />
            {tr(locale, "重命名", "Rename")}
          </button>
          <button className="button danger" disabled={!project} onClick={onDeleteProject}>
            <Trash2 size={14} />
            {tr(locale, "删除", "Delete")}
          </button>
          <span />
          {managerTab === "scenes" && (
            <>
              <button className="button" onClick={onImport}>
                <FileUp size={15} />
                {tr(locale, "导入", "Import")}
              </button>
              <button className="button primary" onClick={openCreateDialog}>
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
        </div>
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
            {isAdmin && (
              <>
                <div className="project-cloud-strip">
                  <span>
                    <CloudCog />
                    <strong>{tr(locale, "项目云渲染", "Project cloud rendering")}</strong>
                    <small>
                      {cloudConfigured
                        ? tr(locale, "一键为全部已发布场景创建云渲染链接", "Create cloud links for every published scene")
                        : tr(locale, "请先完成云渲染全局设置", "Complete cloud rendering settings first")}
                    </small>
                  </span>
                  <button
                    className="button"
                    disabled={!cloudConfigured || projectCloudBusy || !sortedScenes.some((scene) => scene.publishedAt)}
                    onClick={() => void enableProjectCloudRender()}
                  >
                    {projectCloudBusy ? <RefreshCw className="spin" /> : <CloudCog />}
                    {tr(locale, "一键开启", "Enable all")}
                  </button>
                </div>
                {cloudError && (
                  <div className="project-cloud-error">
                    <AlertTriangle size={13} />
                    <span>{cloudError}</span>
                    <button onClick={() => setCloudError(undefined)} aria-label={tr(locale, "关闭提示", "Dismiss")}>
                      ×
                    </button>
                  </div>
                )}
              </>
            )}

            {scenes.length > 0 ? (
              <div className="scene-card-grid">
                {sortedScenes.map((scene) => (
                  <article className="scene-card" key={scene.id}>
                    <button className="scene-card-preview" onClick={() => void onOpen(scene)}>
                      {scene.publishedAt && (
                        <span className="scene-published-badge">
                          <Rocket size={11} />
                          {tr(locale, "已发布", "Published")}
                        </span>
                      )}
                      <span className="scene-card-orbit" />
                      <Layers3 size={34} />
                      <small>
                        {scene.models.length + scene.primitives.length + scene.measurements.length + (scene.annotations?.length ?? 0)} {tr(locale, "个对象", "objects")}
                      </small>
                    </button>
                    <div className="scene-card-body">
                      <button className="scene-card-title" onClick={() => void onOpen(scene)}>
                        {scene.name}
                      </button>
                      <div className="scene-card-meta">
                        <CalendarDays size={12} />
                        {tr(locale, "更新于", "Updated")} {new Date(scene.updatedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                      </div>
                      {scene.publishedAt && (
                        <div className="scene-card-publish-time">
                          <Rocket size={11} />
                          {tr(locale, "发布于", "Published")} {new Date(scene.publishedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                        </div>
                      )}
                      {scene.publishedAt && (
                        <div className="scene-publication-links">
                          <button onClick={() => void copyLink(new URL(`/published/${encodeURIComponent(scene.id)}`, window.location.origin).href)}>
                            <Copy size={11} />
                            {tr(locale, "复制普通链接", "Copy web link")}
                          </button>
                          {cloudSceneLinks[scene.id] && (
                            <button onClick={() => void copyLink(cloudSceneLinks[scene.id]!)}>
                              <Copy size={11} />
                              {tr(locale, "复制云渲染链接", "Copy cloud link")}
                            </button>
                          )}
                        </div>
                      )}
                      {isAdmin && scene.publishedAt && (
                        <div className="scene-cloud-render-policy">
                          <span>
                            <CloudCog size={12} />
                            {tr(locale, "云渲染", "Cloud rendering")}
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={Boolean(cloudScenePolicies[scene.id])}
                            className={`toggle ${cloudScenePolicies[scene.id] ? "on" : ""}`}
                            disabled={!cloudConfigured || cloudBusySceneId === scene.id}
                            title={!cloudConfigured ? tr(locale, "请先完成云渲染全局设置", "Configure cloud rendering first") : undefined}
                            onClick={() => void toggleSceneCloudRender(scene.id, !cloudScenePolicies[scene.id])}
                          >
                            <i />
                            {cloudBusySceneId === scene.id
                              ? tr(locale, "保存中", "Saving")
                              : cloudScenePolicies[scene.id]
                                ? tr(locale, "已开启", "Enabled")
                                : tr(locale, "已关闭", "Disabled")}
                          </button>
                        </div>
                      )}
                      <div className="scene-card-footer">
                        <span>
                          {scene.measurements.length} {tr(locale, "条测量", "measurements")} · {scene.annotations?.length ?? 0} {tr(locale, "个标签", "annotations")}
                        </span>
                        <div>
                          <button
                            title={scene.publishedAt ? tr(locale, "重新发布", "Republish") : tr(locale, "发布", "Publish")}
                            onClick={() => {
                              setPublishMode(scene.publicationMode ?? "webgl");
                              setPublishPerformance(scene.publicationPerformance ?? "standard");
                              setPublishTarget(scene);
                            }}
                          >
                            <Rocket size={14} />
                          </button>
                          {scene.publishedAt && (
                            <>
                              <button title={tr(locale, "版本历史", "Version history")} onClick={() => void openVersions(scene)}>
                                <History size={14} />
                              </button>
                              <button title={tr(locale, "撤回发布", "Unpublish")} onClick={() => void onUnpublish(scene)}>
                                <Square size={13} />
                              </button>
                            </>
                          )}
                          <button title={tr(locale, "复制场景", "Copy scene")} onClick={() => void onCopy(scene)}>
                            <Copy size={14} />
                          </button>
                          <button title={tr(locale, "重命名场景", "Rename scene")} onClick={() => openRenameDialog(scene)}>
                            <Pencil size={14} />
                          </button>
                          <button title={tr(locale, "打开项目", "Open project")} onClick={() => void onOpen(scene)}>
                            <Eye size={14} />
                          </button>
                          <SceneExportMenu
                            locale={locale}
                            compact
                            onExportLoose={() => onExportLoose(scene)}
                            onExportSingle={() => void onExportSingle(scene)}
                            onExportGlb={() => void onExportGlb(scene)}
                            onExportFbx={() => void onExportFbx(scene)}
                          />
                          <button title={tr(locale, "删除场景", "Delete scene")} className="danger" onClick={() => void onDelete(scene)}>
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
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
                    <button className="manager-topology-preview" onClick={() => onOpenTopology(applicationId, topology.id)}>
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

      <div className="app-copyright">{branding.copyright}</div>

      <SceneManagerDialogs controller={controller} />
    </main>
  );
}
