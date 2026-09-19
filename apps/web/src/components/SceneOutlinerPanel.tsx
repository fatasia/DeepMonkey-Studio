import { lazy, Suspense, useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Boxes,
  LoaderCircle,
  Plus,
  Search,
  Upload,
  X,
} from "lucide-react";
import type {
  RevitRuntimeInfo,
  RvtConversionMode,
  IndustrialPrefabDefinition,
  ProjectAssetRecord,
  ModelRecord,
} from "@bim-studio/contracts";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import { translate as tr, type AppLocale } from "../i18n";
import type { DeviceBoxDraft } from "../deviceLayout/deviceLayout";
import type { ComponentRecord } from "../viewer/ViewerEngine";
import type { ConfirmedSmartAssetMapping } from "./smartAssetBindingWorkbenchModel";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import { IndustrialPrefabThumbnail } from "./IndustrialPrefabThumbnail";
import { readSceneAssetDrag, SCENE_ASSET_MIME } from "./sceneAssetDrag";
import { useAssetLibraryCatalog } from "./useAssetLibraryCatalog";
import { RvtImportSettings } from "./RvtImportSettings";

const DeviceLayoutWorkbench = lazy(() => import("./DeviceLayoutWorkbench").then((module) => ({ default: module.DeviceLayoutWorkbench })));
const SmartAssetBindingWorkbench = lazy(() => import("./SmartAssetBindingWorkbench").then((module) => ({ default: module.SmartAssetBindingWorkbench })));

interface SceneOutlinerPanelProps {
  locale: AppLocale;
  uploading: boolean;
  importOpen: boolean;
  activeWorkflow?: "device-layout" | "smart-binding" | "model-diff" | null;
  rvtConversionMode: RvtConversionMode;
  revitVersion: string;
  revitRuntime: RevitRuntimeInfo;
  query: string;
  level: string;
  category: string;
  facets: { levels: string[]; categories: string[] };
  results: ComponentRecord[];
  bindingComponents: ComponentRecord[];
  selectedComponentId?: string | undefined;
  searchActive: boolean;
  isolationActive: boolean;
  objectContent: ReactNode;
  projectAssets?: ProjectAssetRecord[];
  projectModels?: ModelRecord[];
  projectId?: string;
  onLibraryImported?: () => Promise<void>;
  onImportClose: () => void;
  onImportModel: () => void;
  onWorkflowClose: () => void;
  onRvtConversionModeChange: (mode: RvtConversionMode) => void;
  onRevitVersionChange: (version: string) => void;
  onInsertProjectModel: (model: ModelRecord) => void;
  onInsertPrefab: (definition: IndustrialPrefabDefinition) => void;
  onCreateDeviceLayout: (devices: DeviceBoxDraft[], createLabels: boolean) => Promise<void> | void;
  onConfirmSmartBindings: (mappings: ConfirmedSmartAssetMapping[]) => void;
  onQueryChange: (query: string) => void;
  onLevelChange: (level: string) => void;
  onCategoryChange: (category: string) => void;
  onResultFocus: (record: ComponentRecord) => void;
  onResultsIsolate: () => void;
  onIsolationRestore: () => void;
}

export function SceneOutlinerPanel(props: SceneOutlinerPanelProps) {
  const [resourceOpen, setResourceOpen] = useState(false);
  const [deviceLayoutBusy, setDeviceLayoutBusy] = useState(false);
  const resourcePanelDrag = useFloatingPanelDrag<HTMLElement>();
  const resourcePanelEscapeRef = useDialogEscape(() => setResourceOpen(false));
  const importSettingsEscapeRef = useDialogEscape(props.onImportClose);
  const activeWorkflow = props.activeWorkflow ?? null;
  const workflowDialogEscapeRef = useDialogEscape(() => {
    if (activeWorkflow === "device-layout" && deviceLayoutBusy) return;
    props.onWorkflowClose();
  });
  const deviceLayoutDialog = activeWorkflow === "device-layout" && typeof document !== "undefined" ? createPortal(
    <div
      className="device-layout-backdrop"
      data-escape-dialog=""
      ref={workflowDialogEscapeRef}
      onMouseDown={() => { if (!deviceLayoutBusy) props.onWorkflowClose(); }}
    >
      <Suspense fallback={<div className="device-layout-loading"><LoaderCircle className="spin" size={15} />{tr(props.locale, "正在载入设备布局工具…", "Loading device layout tool…")}</div>}>
        <DeviceLayoutWorkbench locale={props.locale} onApply={props.onCreateDeviceLayout} onBusyChange={setDeviceLayoutBusy} onClose={props.onWorkflowClose} />
      </Suspense>
    </div>,
    document.body
  ) : null;
  const smartBindingDialog = activeWorkflow === "smart-binding" && typeof document !== "undefined" ? createPortal(
    <div
      className="smart-binding-backdrop"
      data-escape-dialog=""
      ref={workflowDialogEscapeRef}
      onMouseDown={() => props.onWorkflowClose()}
    >
      <Suspense fallback={<div className="device-layout-loading"><LoaderCircle className="spin" size={15} />{tr(props.locale, "正在载入智能绑定…", "Loading smart binding…")}</div>}>
        <SmartAssetBindingWorkbench locale={props.locale} components={props.bindingComponents} onClose={props.onWorkflowClose} onConfirm={(mappings) => { props.onConfirmSmartBindings(mappings); props.onWorkflowClose(); }} />
      </Suspense>
    </div>,
    document.body
  ) : null;
  const resourcePanel = resourceOpen && typeof document !== "undefined" ? createPortal(
    <section
      className="scene-resource-floating"
      role="dialog"
      aria-label={tr(props.locale, "场景资源浮窗", "Scene resources panel")}
      data-escape-dialog=""
      ref={(element) => {
        resourcePanelDrag.panelRef.current = element;
        resourcePanelEscapeRef(element);
      }}
      style={resourcePanelDrag.style}
      onPointerDown={resourcePanelDrag.onPointerDown}
      onPointerMove={resourcePanelDrag.onPointerMove}
      onPointerUp={resourcePanelDrag.onPointerUp}
      onPointerCancel={resourcePanelDrag.onPointerCancel}
    >
      <header>
        <span>
          <strong>{tr(props.locale, "添加模型", "Add model")}</strong>
        </span>
        <button
          type="button"
          aria-label={tr(props.locale, "关闭资源浮窗", "Close resources panel")}
          title={tr(props.locale, "关闭资源浮窗", "Close resources panel")}
          onClick={() => setResourceOpen(false)}
        >
          <X size={14} />
        </button>
      </header>
      <SceneResourceBrowser {...props} />
    </section>,
    document.body
  ) : null;
  const importSettingsDialog = props.importOpen && typeof document !== "undefined" ? createPortal(
    <div className="dialog-backdrop" data-escape-dialog="" ref={importSettingsEscapeRef} onMouseDown={props.onImportClose}>
      <section className="dialog scene-import-settings-dialog" role="dialog" aria-modal="true" aria-label={tr(props.locale, "RVT 导入设置", "RVT import settings")} onMouseDown={(event) => event.stopPropagation()}>
        <span className="eyebrow">RVT / REVIT</span>
        <h2>{tr(props.locale, "导入设置", "Import settings")}</h2>
        <p>{tr(props.locale, "这些选项仅影响 RVT 文件；其他模型格式会忽略它们。", "These options only affect RVT files; other formats ignore them.")}</p>
        <RvtImportSettings locale={props.locale} mode={props.rvtConversionMode} revitVersion={props.revitVersion} runtime={props.revitRuntime} onModeChange={props.onRvtConversionModeChange} onRevitVersionChange={props.onRevitVersionChange} />
        <div className="dialog-actions">
          <button type="button" className="button" onClick={props.onImportClose}>{tr(props.locale, "完成", "Done")}</button>
          <button type="button" className="button primary" onClick={() => { props.onImportClose(); props.onImportModel(); }}>{tr(props.locale, "选择 RVT 文件", "Choose RVT file")}</button>
        </div>
      </section>
    </div>,
    document.body,
  ) : null;
  return (
    <aside className="left-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{tr(props.locale, "场景目录", "SCENE OUTLINER")}</span>
          <h2>{tr(props.locale, "场景对象", "Scene objects")}</h2>
        </div>
        <div className="panel-heading-actions">
          <button
            className={`panel-mode-button ${resourceOpen ? "active" : ""}`}
            title={tr(props.locale, "浏览并插入资源", "Browse and insert resources")}
            aria-label={tr(props.locale, "资源", "Resources")}
            onClick={() => { const next = !resourceOpen; setResourceOpen(next); if (next) props.onImportClose(); }}
          >
            <Boxes size={17} />
            <span>{tr(props.locale, "资源", "Resources")}</span>
          </button>
          <button
            className="icon-button"
            aria-label={tr(props.locale, "导入模型", "Import model")}
            title={tr(props.locale, "导入模型", "Import model")}
            onClick={() => { setResourceOpen(false); props.onImportModel(); }}
            disabled={props.uploading}
          >
            {props.uploading ? (
              <LoaderCircle className="spin" size={18} />
            ) : (
              <Plus size={18} />
            )}
          </button>
        </div>
      </div>
      {!resourceOpen && (
        <ComponentSearch {...props} />
      )}
      {!resourceOpen && (
        <div className="asset-list unified-object-manager">
          {props.objectContent}
        </div>
      )}
      {deviceLayoutDialog}
      {smartBindingDialog}
      {resourcePanel}
      {importSettingsDialog}
    </aside>
  );
}

export function SceneResourceBrowser(props: Pick<SceneOutlinerPanelProps, "locale" | "projectAssets" | "projectModels" | "projectId" | "onLibraryImported" | "onImportModel" | "onInsertProjectModel" | "onInsertPrefab">) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"platform" | "prefab" | "project">(() => props.projectId ? "platform" : (props.projectModels?.length || props.projectAssets?.length) ? "project" : "prefab");
  const [showAll, setShowAll] = useState(false);
  const browserRef = useRef<HTMLElement | null>(null);
  const draggingAsset = useRef<{ source: "library" | "model"; id: string } | null>(null);
  const dragDropHandled = useRef(false);
  const insertProjectModelRef = useRef(props.onInsertProjectModel);
  const projectModelsRef = useRef(props.projectModels ?? []);
  insertProjectModelRef.current = props.onInsertProjectModel;
  projectModelsRef.current = props.projectModels ?? [];
  const catalog = useAssetLibraryCatalog(props.projectId, props.onLibraryImported ?? (async () => {}), { dimension: "3d", featuredOnly: false });
  const assets = (props.projectAssets ?? []).map((asset) => ({ source: "asset" as const, id: asset.id, name: asset.name, fileName: asset.fileName, kind: asset.kind, thumbnailUrl: asset.thumbnailUrl, asset }));
  const models = (props.projectModels ?? []).map((model) => ({ source: "model" as const, id: model.id, name: model.name, fileName: model.format.toUpperCase(), kind: "model", thumbnailUrl: model.thumbnailUrl ?? (model.libraryOrigin?.itemId ? `/api/public/asset-library/items/${model.libraryOrigin.itemId}/thumbnail` : undefined), model }));
  const prefabs = INDUSTRIAL_PREFAB_CATALOG.map((definition) => ({ source: "prefab" as const, id: definition.id, name: tr(props.locale, definition.name, definition.englishName), fileName: definition.routeCapable ? tr(props.locale, "路线与动作", "Route & actions") : tr(props.locale, "参数与数据口", "Parameters & ports"), kind: definition.kind, thumbnailUrl: undefined, definition }));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const scopedResources = scope === "prefab" ? prefabs : [...models, ...assets];
  const resources = scopedResources.filter((resource) => `${resource.name} ${resource.fileName} ${resource.kind}`.toLocaleLowerCase().includes(normalizedQuery));
  const visibleResources = normalizedQuery || showAll ? resources : resources.slice(0, 24);
  const platformItems = catalog.result.items.filter((item) => item.dimension === "3d");
  const resultCount = scope === "platform" ? catalog.result.total : resources.length;
  async function insertLibraryItem(itemId: string) {
    const item = platformItems.find(item => item.id === itemId);
    if (!props.projectId || catalog.importingId || item?.publicationStatus !== "published") return;
    const existing = (props.projectModels ?? []).find((model) => model.libraryOrigin?.itemId === itemId);
    if (existing) return props.onInsertProjectModel(existing);
    const imported = await catalog.importItem(itemId);
    if (imported?.kind === "model") props.onInsertProjectModel(imported.model);
  }
  function beginAssetDrag(event: DragEvent, source: "library" | "model", id: string) {
    draggingAsset.current = { source, id };
    dragDropHandled.current = false;
    event.dataTransfer.effectAllowed = "copy";
    const payload = JSON.stringify({ source, id });
    event.dataTransfer.setData(SCENE_ASSET_MIME, payload);
    // Keep a standards-compatible fallback for browser automation and native
    // drag sources that strip custom MIME types during a cross-node drop.
    event.dataTransfer.setData("text/plain", payload);
  }
  function captureAssetDrag(dataTransfer: DataTransfer) {
    const payload = readSceneAssetDrag(dataTransfer.getData(SCENE_ASSET_MIME) || dataTransfer.getData("text/plain"));
    if (payload) {
      draggingAsset.current = payload;
      dragDropHandled.current = false;
    }
    return payload;
  }
  useEffect(() => {
    const root = browserRef.current;
    if (!root) return;
    const readEventPayload = (event: Event) => {
      const transfer = (event as unknown as DragEvent).dataTransfer;
      if (!transfer) return undefined;
      try { return readSceneAssetDrag(transfer.getData(SCENE_ASSET_MIME) || transfer.getData("text/plain")); } catch { return undefined; }
    };
    const handleDragStart = (event: Event) => {
      const payload = readEventPayload(event);
      if (payload) {
        draggingAsset.current = payload;
        dragDropHandled.current = false;
      }
    };
    const insertFromGesture = (event: Event) => {
      if (dragDropHandled.current) return;
      const payload = readEventPayload(event) ?? draggingAsset.current;
      if (!payload || payload.source !== "model") return;
      const model = projectModelsRef.current.find((item) => item.id === payload.id);
      if (model?.status !== "ready") return;
      event.preventDefault();
      dragDropHandled.current = true;
      insertProjectModelRef.current(model);
    };
    root.addEventListener("dragstart", handleDragStart, true);
    root.addEventListener("drop", insertFromGesture, true);
    root.addEventListener("dragend", insertFromGesture, true);
    return () => {
      root.removeEventListener("dragstart", handleDragStart, true);
      root.removeEventListener("drop", insertFromGesture, true);
      root.removeEventListener("dragend", insertFromGesture, true);
    };
  }, []);
  async function dropAsset(event: DragEvent) {
    if (dragDropHandled.current) return;
    const hasAssetPayload = event.dataTransfer.types.includes(SCENE_ASSET_MIME) || event.dataTransfer.types.includes("text/plain") || Boolean(draggingAsset.current);
    if (!hasAssetPayload) return;
    event.preventDefault();
    event.stopPropagation();
    // Some native/WebDriver implementations expose the drag type but strip
    // the payload on the drop event. Keep the source captured at dragstart as
    // the authoritative fallback, and only mark the gesture handled after a
    // real insertion was dispatched.
    const payload = readSceneAssetDrag(event.dataTransfer.getData(SCENE_ASSET_MIME) || event.dataTransfer.getData("text/plain")) ?? draggingAsset.current;
    if (!payload || catalog.importingId) return;
    if (payload.source === "library") {
      dragDropHandled.current = true;
      await insertLibraryItem(payload.id);
      return;
    }
    const model = (props.projectModels ?? []).find(item => item.id === payload.id);
    if (model?.status !== "ready") return;
    dragDropHandled.current = true;
    props.onInsertProjectModel(model);
  }
  function endAssetDrag() {
    // Native/WebDriver drag paths may deliver dragend without preserving the
    // custom DataTransfer payload at drop. Keep the same product action for
    // that gesture instead of silently discarding the load.
    const payload = draggingAsset.current;
    draggingAsset.current = null;
    if (!payload || dragDropHandled.current) return;
    if (payload.source === "library") {
      dragDropHandled.current = true;
      void insertLibraryItem(payload.id);
    } else {
      const model = (props.projectModels ?? []).find(item => item.id === payload.id);
      if (model?.status !== "ready") return;
      dragDropHandled.current = true;
      props.onInsertProjectModel(model);
    }
  }
  return <section ref={browserRef} className="scene-resource-browser" aria-label={tr(props.locale, "场景资源", "Scene resources")} onDragEnd={endAssetDrag}>
    <div className="scene-resource-search-row">
      <label className="component-search-input"><Search size={14} /><input value={query} onChange={(event) => { const value = event.target.value; setQuery(value); if (scope === "platform") catalog.updateSearch(value); }} placeholder={tr(props.locale, "搜索模型", "Search models")} /></label>
      <button type="button" className="scene-resource-upload" onClick={props.onImportModel} title={tr(props.locale, "本地导入", "Import local model")}><Upload size={14} /></button>
    </div>
    <nav className="scene-resource-scopes" aria-label={tr(props.locale, "资源范围", "Resource scope")}>
      <button className={scope === "platform" ? "active" : ""} onClick={() => { setScope("platform"); catalog.updateSearch(query); }}>{tr(props.locale, "平台素材", "Library")}</button>
      <button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>{tr(props.locale, "项目资源", "Project")}</button>
      <button className={scope === "prefab" ? "active" : ""} onClick={() => setScope("prefab")}>{tr(props.locale, "工业预制体", "Prefabs")}</button>
    </nav>
    <div className="scene-resource-count">{resultCount.toLocaleString()} {tr(props.locale, "项", "items")}</div>
    <div className="scene-resource-drop-target" onDragOver={event => { const payload = captureAssetDrag(event.dataTransfer); if (payload || event.dataTransfer.types.includes(SCENE_ASSET_MIME) || event.dataTransfer.types.includes("text/plain") || draggingAsset.current) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }} onDrop={event => void dropAsset(event)}>
      <Plus size={13} />{tr(props.locale, "将模型拖到这里载入当前场景", "Drag a model here to load it into the current scene")}
    </div>
    {scope === "platform" ? catalog.loading ? <div className="scene-resource-loading"><LoaderCircle className="spin" size={18} /></div> : platformItems.length > 0 ? <>
      <div className="scene-resource-grid">{platformItems.map((item) => <article className="scene-resource-card" key={item.id} draggable={Boolean(props.projectId && !catalog.importingId && item.publicationStatus === "published")} onDragStart={event => beginAssetDrag(event, "library", item.id)} onDragEnd={endAssetDrag} onMouseUp={endAssetDrag}>
        <img src={item.thumbnailUrl} alt="" />
        <div><strong title={item.name}>{item.name}</strong><small>{item.category} · {(item.triangleCount / 1000).toFixed(0)}k</small></div>
        <button type="button" title={tr(props.locale, `载入 ${item.name}`, `Load ${item.name}`)} disabled={!props.projectId || Boolean(catalog.importingId) || item.publicationStatus !== "published"} onClick={() => void insertLibraryItem(item.id)}>{catalog.importingId === item.id ? <LoaderCircle className="spin" size={12} /> : <Plus size={12} />}</button>
      </article>)}</div>
      {catalog.result.totalPages > 1 && <div className="scene-resource-pager"><button disabled={catalog.result.page <= 1} onClick={() => catalog.setPage(catalog.result.page - 1)}>‹</button><span>{catalog.result.page}/{catalog.result.totalPages}</span><button disabled={catalog.result.page >= catalog.result.totalPages} onClick={() => catalog.setPage(catalog.result.page + 1)}>›</button></div>}
    </> : <div className="scene-resource-empty"><Boxes size={22} /><strong>{catalog.catalogError ?? tr(props.locale, "暂无匹配模型", "No matching models")}</strong></div> : visibleResources.length > 0 ? <>
      <div className="scene-resource-list">{visibleResources.map((resource) => <article className="scene-resource-row" data-model-id={resource.source === "model" ? resource.id : undefined} data-model-status={resource.source === "model" ? resource.model.status : undefined} data-resource-source={resource.source} key={`${resource.source}:${resource.id}`} draggable={resource.source === "model" && resource.model.status === "ready"} onMouseDown={resource.source === "model" ? event => { if (!(event.target as HTMLElement).closest("button")) { draggingAsset.current = { source: "model", id: resource.id }; dragDropHandled.current = false; } } : undefined} onDragStart={resource.source === "model" ? event => beginAssetDrag(event, "model", resource.id) : undefined} onDragEnd={resource.source === "model" ? endAssetDrag : undefined} onMouseUp={resource.source === "model" ? endAssetDrag : undefined}>
        {resource.thumbnailUrl
          ? <img src={resource.thumbnailUrl} alt="" />
          : resource.source === "prefab"
            ? <IndustrialPrefabThumbnail definition={resource.definition} />
            : <span className={`scene-resource-icon resource-${resource.source}`}><Boxes size={16} /></span>}
        <div><strong title={resource.name}>{resource.name}</strong><small>{resource.kind} · {resource.fileName}</small></div>
        {resource.source === "prefab" ? <button type="button" onClick={() => props.onInsertPrefab(resource.definition)} title={tr(props.locale, "插入并选中可配置预制体", "Insert and select configurable prefab")}>{tr(props.locale, "插入", "Insert")}</button>
          : resource.source === "model" ? <button type="button" onClick={() => props.onInsertProjectModel(resource.model)} title={tr(props.locale, "将项目模型载入当前场景", "Load project model into this scene")}>{tr(props.locale, "载入", "Load")}</button>
            : <span className="scene-resource-use-hint">{tr(props.locale, "属性中应用", "Use in inspector")}</span>}
      </article>)}</div>
      {!normalizedQuery && resources.length > visibleResources.length && <button className="scene-resource-more" type="button" onClick={() => setShowAll(true)}>{tr(props.locale, `显示全部 ${resources.length} 项`, `Show all ${resources.length}`)}</button>}
    </> : <div className="scene-resource-empty"><Boxes size={22} /><strong>{tr(props.locale, "暂无匹配资源", "No matching resources")}</strong></div>}
    {catalog.importError && <p className="scene-resource-error" role="alert">{catalog.importError}</p>}
  </section>;
}

function ComponentSearch(props: SceneOutlinerPanelProps) {
  return (
    <section
      className="component-search"
      aria-label={tr(props.locale, "构件查询", "Component search")}
    >
      <div className="component-search-input">
        <Search size={15} />
        <input
          value={props.query}
          onChange={(event) => props.onQueryChange(event.target.value)}
          placeholder={tr(
            props.locale,
            "搜索名称、ID、属性",
            "Search name, ID or property",
          )}
          aria-label={tr(props.locale, "搜索构件", "Search components")}
        />
        {props.query && (
          <button
            title={tr(props.locale, "清空搜索", "Clear search")}
            onClick={() => props.onQueryChange("")}
          >
            <X size={13} />
          </button>
        )}
      </div>
      {(props.facets.levels.length > 0 ||
        props.facets.categories.length > 0) && (
        <div className="component-filters">
          <select
            value={props.level}
            onChange={(event) => props.onLevelChange(event.target.value)}
            aria-label={tr(props.locale, "按楼层筛选", "Filter by floor")}
          >
            <option value="">
              {tr(props.locale, "全部楼层", "All floors")}
            </option>
            {props.facets.levels.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            value={props.category}
            onChange={(event) => props.onCategoryChange(event.target.value)}
            aria-label={tr(props.locale, "按类别筛选", "Filter by category")}
          >
            <option value="">
              {tr(props.locale, "全部类别", "All categories")}
            </option>
            {props.facets.categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      )}
      {props.searchActive && (
        <div className="component-results">
          <div className="component-results-head">
            <span>
              {props.results.length} {tr(props.locale, "个结果", "results")}
            </span>
            <div>
              <button
                disabled={props.results.length === 0}
                onClick={props.onResultsIsolate}
              >
                {tr(props.locale, "隔离结果", "Isolate")}
              </button>
              {props.isolationActive && (
                <button onClick={props.onIsolationRestore}>
                  {tr(props.locale, "恢复", "Restore")}
                </button>
              )}
            </div>
          </div>
          <div className="component-result-list">
            {props.results.map((record) => (
              <button
                key={record.stableId}
                className={
                  props.selectedComponentId === record.stableId
                    ? "selected"
                    : ""
                }
                onClick={() => props.onResultFocus(record)}
              >
                <strong title={record.name}>{record.name}</strong>
                <small>
                  {[record.level, record.category, record.type]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </button>
            ))}
            {props.results.length === 0 && (
              <span className="component-no-result">
                {tr(props.locale, "没有匹配构件", "No matching components")}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
