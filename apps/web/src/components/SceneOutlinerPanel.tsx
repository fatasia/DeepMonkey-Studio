import { lazy, Suspense, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Boxes,
  Layers3,
  Link2,
  ListChecks,
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
import { REVIT_VERSION_STORAGE_KEY } from "../appDefaults";
import { translate as tr, type AppLocale } from "../i18n";
import type { DeviceBoxDraft } from "../deviceLayout/deviceLayout";
import type { ComponentRecord } from "../viewer/ViewerEngine";
import type { ConfirmedSmartAssetMapping } from "./smartAssetBindingWorkbenchModel";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import { IndustrialPrefabThumbnail } from "./IndustrialPrefabThumbnail";

const DeviceLayoutWorkbench = lazy(() => import("./DeviceLayoutWorkbench").then((module) => ({ default: module.DeviceLayoutWorkbench })));
const SmartAssetBindingWorkbench = lazy(() => import("./SmartAssetBindingWorkbench").then((module) => ({ default: module.SmartAssetBindingWorkbench })));

interface SceneOutlinerPanelProps {
  locale: AppLocale;
  uploading: boolean;
  importOpen: boolean;
  organizationOpen: boolean;
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
  organizationContent: ReactNode;
  objectContent: ReactNode;
  assetWorkflowEntry?: ReactNode;
  projectAssets?: ProjectAssetRecord[];
  projectModels?: ModelRecord[];
  onOrganizationToggle: () => void;
  onImportToggle: () => void;
  onImportClose: () => void;
  onRvtConversionModeChange: (mode: RvtConversionMode) => void;
  onRevitVersionChange: (version: string) => void;
  onUpload: () => void;
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
  return (
    <aside className="left-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">{tr(props.locale, "场景目录", "SCENE OUTLINER")}</span>
          <h2>{tr(props.locale, "场景对象", "Scene objects")}</h2>
        </div>
        <div className="panel-heading-actions">
          <button
            className={`panel-mode-button ${props.organizationOpen ? "active" : ""}`}
            title={tr(
              props.locale,
              "多选、编组与层级管理",
              "Multi-select, grouping and hierarchy",
            )}
            aria-label={tr(props.locale, "场景图层与编组", "Scene layers and groups")}
            onClick={() => { setResourceOpen(false); props.onOrganizationToggle(); }}
          >
            <ListChecks size={17} />
            <span>{tr(props.locale, "层级", "Layers")}</span>
          </button>
          <button
            className={`panel-mode-button ${resourceOpen ? "active" : ""}`}
            title={tr(props.locale, "浏览并插入资源", "Browse and insert resources")}
            aria-label={tr(props.locale, "资源", "Resources")}
            onClick={() => { const next = !resourceOpen; setResourceOpen(next); if (next) { props.onImportClose(); if (props.organizationOpen) props.onOrganizationToggle(); } }}
          >
            <Boxes size={17} />
            <span>{tr(props.locale, "资源", "Resources")}</span>
          </button>
          <button
            className={`icon-button ${props.importOpen ? "active" : ""}`}
            aria-label={tr(props.locale, "导入模型与转换设置", "Import models and conversion settings")}
            title={tr(
              props.locale,
              "导入模型与转换设置",
              "Import models and conversion settings",
            )}
            onClick={() => { setResourceOpen(false); props.onImportToggle(); }}
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
      {(props.importOpen || resourceOpen) && props.assetWorkflowEntry}
      {props.importOpen && <ImportWorkspace {...props} />}
      {resourceOpen && !props.importOpen && <SceneResourceBrowser {...props} />}
      {!props.organizationOpen && !props.importOpen && !resourceOpen && (
        <ComponentSearch {...props} />
      )}
      {!props.importOpen && !resourceOpen && (
        <div
          className={`asset-list ${props.organizationOpen ? "organization-mode" : ""}`}
        >
          {props.organizationOpen
            ? props.organizationContent
            : props.objectContent}
        </div>
      )}
    </aside>
  );
}

export function SceneResourceBrowser(props: Pick<SceneOutlinerPanelProps, "locale" | "projectAssets" | "projectModels" | "onImportToggle" | "onInsertProjectModel" | "onInsertPrefab">) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "prefab" | "project">("all");
  const [showAll, setShowAll] = useState(false);
  const assets = (props.projectAssets ?? []).map((asset) => ({ source: "asset" as const, id: asset.id, name: asset.name, fileName: asset.fileName, kind: asset.kind, thumbnailUrl: asset.thumbnailUrl, asset }));
  const models = (props.projectModels ?? []).map((model) => ({ source: "model" as const, id: model.id, name: model.name, fileName: model.format.toUpperCase(), kind: "model", thumbnailUrl: undefined, model }));
  const prefabs = INDUSTRIAL_PREFAB_CATALOG.map((definition) => ({ source: "prefab" as const, id: definition.id, name: tr(props.locale, definition.name, definition.englishName), fileName: definition.routeCapable ? tr(props.locale, "路线与动作", "Route & actions") : tr(props.locale, "参数与数据口", "Parameters & ports"), kind: definition.kind, thumbnailUrl: undefined, definition }));
  const allResources = [...models, ...assets, ...prefabs];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const scopedResources = allResources.filter((resource) => scope === "all" || (scope === "prefab" ? resource.source === "prefab" : resource.source !== "prefab"));
  const resources = scopedResources.filter((resource) => `${resource.name} ${resource.fileName} ${resource.kind}`.toLocaleLowerCase().includes(normalizedQuery));
  const visibleResources = normalizedQuery || showAll ? resources : resources.slice(0, 24);
  return <section className="scene-resource-browser" aria-label={tr(props.locale, "资源", "Resources")}>
    <header><div><span className="eyebrow">{tr(props.locale, "场景资源", "SCENE RESOURCES")}</span><strong>{tr(props.locale, "资源", "Resources")}</strong></div><small>{allResources.length}</small></header>
    <label className="component-search-input"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr(props.locale, "搜索资源", "Search resources")} /></label>
    <nav className="scene-resource-scopes" aria-label={tr(props.locale, "资源范围", "Resource scope")}>
      <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>{tr(props.locale, "全部", "All")}</button>
      <button className={scope === "prefab" ? "active" : ""} onClick={() => setScope("prefab")}>{tr(props.locale, "工业预制体", "Prefabs")}</button>
      <button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>{tr(props.locale, "项目资源", "Project")}</button>
    </nav>
    {visibleResources.length > 0 ? <>
      <div className="scene-resource-list">{visibleResources.map((resource) => <article className="scene-resource-row" key={`${resource.source}:${resource.id}`}>
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
    </> : <div className="scene-resource-empty"><Boxes size={22} /><strong>{tr(props.locale, "暂无匹配资源", "No matching resources")}</strong><small>{tr(props.locale, "可以清空搜索，或导入自己的模型资源。", "Clear the search or import your own model resource.")}</small><button type="button" onClick={props.onImportToggle}>{tr(props.locale, "导入模型", "Import model")}</button></div>}
  </section>;
}

function ImportWorkspace(props: SceneOutlinerPanelProps) {
  const [deviceLayoutOpen, setDeviceLayoutOpen] = useState(false);
  const [deviceLayoutBusy, setDeviceLayoutBusy] = useState(false);
  const [smartBindingOpen, setSmartBindingOpen] = useState(false);
  const deviceLayoutDialog = deviceLayoutOpen && typeof document !== "undefined" ? createPortal(
    <div className="device-layout-backdrop" onMouseDown={() => { if (!deviceLayoutBusy) setDeviceLayoutOpen(false); }}>
      <Suspense fallback={<div className="device-layout-loading"><LoaderCircle className="spin" size={15} />{tr(props.locale, "正在载入设备布局工具…", "Loading device layout tool…")}</div>}>
        <DeviceLayoutWorkbench locale={props.locale} onApply={props.onCreateDeviceLayout} onBusyChange={setDeviceLayoutBusy} onClose={() => setDeviceLayoutOpen(false)} />
      </Suspense>
    </div>,
    document.body
  ) : null;
  const smartBindingDialog = smartBindingOpen && typeof document !== "undefined" ? createPortal(
    <div className="smart-binding-backdrop" onMouseDown={() => setSmartBindingOpen(false)}>
      <Suspense fallback={<div className="device-layout-loading"><LoaderCircle className="spin" size={15} />{tr(props.locale, "正在载入智能绑定…", "Loading smart binding…")}</div>}>
        <SmartAssetBindingWorkbench
          locale={props.locale}
          components={props.bindingComponents}
          onClose={() => setSmartBindingOpen(false)}
          onConfirm={(mappings) => {
            props.onConfirmSmartBindings(mappings);
            setSmartBindingOpen(false);
          }}
        />
      </Suspense>
    </div>,
    document.body,
  ) : null;
  return (
    <section className="scene-import-workspace">
      <header>
        <span>
          <Upload size={15} />
          <strong>{tr(props.locale, "导入模型", "Import model")}</strong>
        </span>
        <button
          onClick={props.onImportClose}
          aria-label={tr(props.locale, "关闭导入面板", "Close import panel")}
        >
          <X size={14} />
        </button>
      </header>
      <div
        className="rvt-route-switch"
        aria-label={tr(props.locale, "RVT 转换链路", "RVT conversion route")}
      >
        <span>{tr(props.locale, "RVT 转换", "RVT conversion")}</span>
        <button
          className={props.rvtConversionMode === "native-glb" ? "active" : ""}
          onClick={() => props.onRvtConversionModeChange("native-glb")}
        >
          <strong>{tr(props.locale, "原生 GLB", "Native GLB")}</strong>
          <small>{tr(props.locale, "快速 · 推荐", "Fast · Recommended")}</small>
        </button>
        <button
          className={props.rvtConversionMode === "ifc" ? "active" : ""}
          onClick={() => props.onRvtConversionModeChange("ifc")}
        >
          <strong>IFC</strong>
          <small>
            {tr(props.locale, "兼容备用", "Compatibility fallback")}
          </small>
        </button>
      </div>
      <label className="revit-version-select">
        <span>{tr(props.locale, "Revit 版本", "Revit version")}</span>
        <select
          value={props.revitVersion}
          onChange={(event) => {
            props.onRevitVersionChange(event.target.value);
            window.localStorage.setItem(
              REVIT_VERSION_STORAGE_KEY,
              event.target.value,
            );
          }}
        >
          <option value="auto">
            {tr(props.locale, "自动匹配（推荐）", "Auto match (recommended)")}
          </option>
          {props.revitRuntime.installations.map((item) => (
            <option key={item.version} value={item.version}>
              Revit {item.version}
              {item.addinInstalled
                ? " · Ready"
                : ` · ${tr(props.locale, "需安装插件", "Add-in required")}`}
            </option>
          ))}
        </select>
        <small>
          {props.revitRuntime.installations.length > 0
            ? tr(
                props.locale,
                `检测到 ${props.revitRuntime.installations.length} 个本机版本`,
                `${props.revitRuntime.installations.length} local versions detected`,
              )
            : tr(props.locale, "未检测到本机 Revit", "No local Revit detected")}
        </small>
      </label>
      <button className="upload-zone" onClick={props.onUpload}>
        <Upload size={20} />
        <span>{tr(props.locale, "上传模型", "Upload model")}</span>
        <small>
          {tr(
            props.locale,
            "直接查看：IFC / OpenUSD / 网格 · 内置转换：STEP / IGES",
            "Direct viewing: IFC / OpenUSD / meshes · Built-in conversion: STEP / IGES",
          )}
        </small>
      </button>
      <button className="device-layout-entry" onClick={() => setDeviceLayoutOpen(true)}>
        <Boxes size={18} />
        <span><strong>{tr(props.locale, "批量设备布局", "Batch device layout")}</strong><small>{tr(props.locale, "从表格、GeoJSON 或图纸坐标创建方盒与标签", "Create boxes and labels from tables, GeoJSON or drawing coordinates")}</small></span>
      </button>
      <button className="device-layout-entry" onClick={() => setSmartBindingOpen(true)}>
        <Link2 size={18} />
        <span><strong>{tr(props.locale, "设备与测点智能绑定", "Smart asset binding")}</strong><small>{tr(props.locale, "导入设备目录，生成可解释候选并人工确认", "Import a device catalog, review explainable candidates, then confirm")}</small></span>
      </button>
      {deviceLayoutDialog}
      {smartBindingDialog}
    </section>
  );
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
