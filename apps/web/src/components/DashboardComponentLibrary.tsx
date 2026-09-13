import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Box, ChartNoAxesCombined, LayoutTemplate, Plus, Search, Upload, X } from "lucide-react";
import type { DashboardDataWidgetConfig, SceneDashboardWidgetType } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import {
  DASHBOARD_COMPONENT_PRESETS,
  dashboardComponentPresetText,
  type DashboardComponentPreset,
} from "./DashboardComponentCatalog";
import { DashboardComponentPreview } from "./DashboardComponentPreview";
import { DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";
import { dataWidgetTypeLabel } from "./dashboardWorkspaceModel";
import { DASHBOARD_RESOURCE_CATEGORIES, dashboardPresetResourceCategory, type DashboardResourceCategoryKey } from "./dashboardResourceCategories";

type LibrarySource = "basic" | "resources";

export interface DashboardLibraryItem {
  id: string;
  label: string;
  description: string;
  type: SceneDashboardWidgetType;
  badge: string;
  preset?: DashboardComponentPreset;
  widget?: Partial<DashboardDataWidgetConfig>;
}

export const DASHBOARD_LIBRARY_DRAG_TYPE = "application/x-bim-dashboard-component";

interface DashboardComponentLibraryProps {
  locale: AppLocale;
  projectId: string;
  sceneAvailable: boolean;
  topologies?: ReadonlyArray<{ id: string; name: string }>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onOpenTemplates: () => void;
  onAddSceneViewport: () => void;
  onAddWidget: (type: SceneDashboardWidgetType, widget?: Partial<DashboardDataWidgetConfig>, frame?: DashboardComponentPreset["frame"], nameHint?: string) => void;
}

/**
 * 二维组件浏览器只负责“发现与插入”，数据绑定和样式编辑继续由右侧检查器承担。
 * 这样资源库保持轻量，也避免在同一面板重复一套配置逻辑。
 */
export function DashboardComponentLibrary({ locale, projectId, sceneAvailable, topologies = [], searchInputRef, onOpenTemplates, onAddSceneViewport, onAddWidget }: DashboardComponentLibraryProps) {
  const [activeSource, setActiveSource] = useState<LibrarySource>("basic");
  const [activeCategory, setActiveCategory] = useState<DashboardResourceCategoryKey>("data");
  const [query, setQuery] = useState("");
  const [recentlyAddedId, setRecentlyAddedId] = useState<string>();
  const feedbackTimer = useRef<number | undefined>(undefined);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [uploadingKind, setUploadingKind] = useState<"image" | "video">();
  const [uploadError, setUploadError] = useState<string>();
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const items = useMemo(() => activeSource === "basic" ? createBasicLibraryItems(locale) : createResourceLibraryItems(locale, activeCategory, topologies), [activeCategory, activeSource, locale, topologies]);
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return items;
    return createAllLibraryItems(locale, topologies).filter((item) => `${item.label} ${item.description} ${item.badge}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [items, locale, normalizedQuery, topologies]);
  const groupedItems = useMemo(() => groupLibraryItems(filteredItems), [filteredItems]);
  const sceneSearchText = tr(locale, "三维场景视口 嵌入场景 业务联动 3D", "3D scene viewport embed scene business linkage").toLocaleLowerCase();
  const showSceneCard = (!normalizedQuery && activeSource === "basic") || Boolean(normalizedQuery && sceneSearchText.includes(normalizedQuery));
  const resultCount = filteredItems.length + (showSceneCard ? 1 : 0);

  useEffect(() => () => window.clearTimeout(feedbackTimer.current), []);

  function addItem(item: DashboardLibraryItem) {
    onAddWidget(item.type, item.preset?.widget ?? item.widget, item.preset?.frame, item.label);
    setRecentlyAddedId(item.id);
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setRecentlyAddedId(undefined), 1300);
  }

  async function uploadAndInsert(kind: "image" | "video", file: File | undefined) {
    if (!file) return;
    setUploadingKind(kind);
    setUploadError(undefined);
    try {
      const { api } = await import("../api");
      const asset = kind === "image" ? await api.uploadImageAsset(projectId, file) : await api.uploadVideoAsset(projectId, file);
      onAddWidget(kind, kind === "image" ? { assetId: asset.id, imageUrl: asset.url } : { assetId: asset.id, videoUrl: asset.url }, undefined, asset.name);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : tr(locale, "上传失败", "Upload failed"));
    } finally {
      setUploadingKind(undefined);
      if (imageInputRef.current) imageInputRef.current.value = "";
      if (videoInputRef.current) videoInputRef.current.value = "";
    }
  }

  return (
    <div className="dashboard-library-browser">
      <div className="dashboard-library-toolbar">
        <label className="dashboard-library-search">
          <Search size={14} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr(locale, "搜索组件", "Search components")}
          />
        </label>
        {activeSource === "resources" && <div className="dashboard-library-quick-actions">
          <button className="dashboard-library-template-button" title={tr(locale, `行业模板（${DASHBOARD_TEMPLATES.length}）`, `Templates (${DASHBOARD_TEMPLATES.length})`)} onClick={onOpenTemplates}>
            <LayoutTemplate size={14} />
            {tr(locale, "模板", "Templates")}
          </button>
        </div>}
      </div>

      {!normalizedQuery && <div className="dashboard-library-sources" role="tablist" aria-label={tr(locale, "组件来源", "Component source")}>
        <button role="tab" title={tr(locale, "基础控件", "Basic controls")} aria-selected={activeSource === "basic"} className={activeSource === "basic" ? "active" : ""} onClick={() => setActiveSource("basic")}><Box size={14} /><span>{tr(locale, "基础控件", "Basic controls")}</span><small>{createBasicLibraryItems(locale).length + 1}</small></button>
        <button role="tab" title={tr(locale, "资源库", "Library")} aria-selected={activeSource === "resources"} className={activeSource === "resources" ? "active" : ""} onClick={() => setActiveSource("resources")}><LayoutTemplate size={14} /><span>{tr(locale, "资源库", "Library")}</span><small>{createAllResourceItems(locale, topologies).length}</small></button>
      </div>}

      {!normalizedQuery && (
        activeSource === "resources" && <div className="dashboard-library-tabs" role="tablist" aria-label={tr(locale, "资源分类", "Resource categories")}>
          {DASHBOARD_RESOURCE_CATEGORIES.map((category) => {
            const tab = category.key;
            const count = createResourceLibraryItems(locale, tab, topologies).length;
            return (
              <button role="tab" aria-selected={activeCategory === tab} className={activeCategory === tab ? "active" : ""} key={tab} onClick={() => setActiveCategory(tab)}>
                <span>{tr(locale, category.zh, category.en)}</span>
                <small>{count}</small>
              </button>
            );
          })}
        </div>
      )}

      {!normalizedQuery && activeSource === "basic" && (
        <>
          <div className="dashboard-library-local-actions">
            <input ref={imageInputRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif" onChange={(event) => void uploadAndInsert("image", event.target.files?.[0])} />
            <input ref={videoInputRef} hidden type="file" accept="video/mp4,video/webm,video/ogg,application/vnd.apple.mpegurl" onChange={(event) => void uploadAndInsert("video", event.target.files?.[0])} />
            <button disabled={Boolean(uploadingKind)} onClick={() => imageInputRef.current?.click()}><Upload size={13} />{tr(locale, "上传图片", "Upload image")}</button>
            <button disabled={Boolean(uploadingKind)} onClick={() => videoInputRef.current?.click()}><Upload size={13} />{tr(locale, "上传视频", "Upload video")}</button>
          </div>
          {uploadError && <small className="dashboard-library-upload-error" role="alert">{uploadError}</small>}
        </>
      )}

      {normalizedQuery && (
        <div className="dashboard-library-search-summary" role="status">
          <span>{tr(locale, `找到 ${resultCount} 个组件`, `${resultCount} components found`)}</span>
          <button aria-label={tr(locale, "清空组件搜索", "Clear component search")} onClick={() => setQuery("")}>
            <X size={12} />
          </button>
        </div>
      )}

      <div className="dashboard-library-results" aria-live="polite">
        {showSceneCard && (
          <button
            className="dashboard-library-card dashboard-library-scene-card"
            draggable={sceneAvailable}
            disabled={!sceneAvailable}
            onDragStart={(event) => beginLibraryDrag(event.dataTransfer, "scene")}
            onClick={() => onAddSceneViewport()}
            title={sceneAvailable ? tr(locale, "插入三维场景视口", "Insert 3D scene viewport") : tr(locale, "请先创建三维场景", "Create a 3D scene first")}
          >
            <DashboardComponentPreview type="scene" />
            <span>
              <strong>{tr(locale, "三维场景视口", "3D scene viewport")}</strong>
            </span>
            <Plus size={14} />
          </button>
        )}

        {groupedItems.map((group) => (
          <section className="dashboard-library-result-group" key={group.label}>
            <header>
              <strong>{group.label}</strong>
              <span>{group.items.length}</span>
            </header>
            <div>
              {group.items.map((item) => (
                <button
                  className={`dashboard-library-card ${recentlyAddedId === item.id ? "added" : ""}`}
                  draggable
                  key={item.id}
                  title={`${item.description} · ${tr(locale, "可拖到画布", "Drag onto canvas")}`}
                  onDragStart={(event) => beginLibraryDrag(event.dataTransfer, item.id)}
                  onClick={() => addItem(item)}
                >
                  <DashboardComponentPreview
                    type={item.type}
                    showMark={false}
                    {...(item.widget?.decorationStyle || item.preset?.widget.decorationStyle
                      ? { decorationStyle: item.widget?.decorationStyle ?? item.preset!.widget.decorationStyle! }
                      : {})}
                    {...(item.preset ? { preview: item.preset.preview } : {})}
                  />
                  <span>
                    <strong>{item.label}</strong>
                    {recentlyAddedId === item.id && <em>{tr(locale, "已添加", "Added")}</em>}
                  </span>
                  <Plus size={14} />
                </button>
              ))}
            </div>
          </section>
        ))}

        {resultCount === 0 && (
          <div className="dashboard-library-empty">
            <ChartNoAxesCombined size={24} />
            <strong>{tr(locale, "没有匹配的组件", "No matching components")}</strong>
            <small>{tr(locale, "换个关键词，或清空搜索查看全部资源。", "Try another keyword or clear the search.")}</small>
            <button onClick={() => setQuery("")}>{tr(locale, "清空搜索", "Clear search")}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function groupLibraryItems(items: readonly DashboardLibraryItem[]): Array<{ label: string; items: DashboardLibraryItem[] }> {
  const groups = new Map<string, DashboardLibraryItem[]>();
  for (const item of items) groups.set(item.badge, [...(groups.get(item.badge) ?? []), item]);
  return [...groups].map(([label, groupItems]) => ({ label, items: groupItems }));
}

const BASIC_GROUPS: ReadonlyArray<{ zh: string; en: string; types: readonly SceneDashboardWidgetType[] }> = [
  { zh: "内容与容器", en: "Content & layout", types: ["shape"] },
  { zh: "数据展示", en: "Data display", types: ["value", "digital-flip", "liquid-fill", "progress", "status", "gauge", "line", "area", "bar", "combo", "pie", "scatter", "radar", "funnel", "sankey", "sunburst", "treemap", "graph", "map", "wordcloud", "boxplot", "waterfall", "polarBar", "rank", "table", "scroll-table"] },
  { zh: "交互输入", en: "Input & interaction", types: ["record-form"] },
  { zh: "媒体", en: "Media", types: ["image", "video", "monitor", "url"] },
  { zh: "空间与集成", en: "Spatial & integration", types: ["unity", "topology"] },
];

function createBasicLibraryItems(locale: AppLocale): DashboardLibraryItem[] {
  const variants: DashboardLibraryItem[] = [
    { id: "basic:title", label: tr(locale, "标题", "Title"), description: tr(locale, "页面标题或分区标题", "Page or section title"), type: "text", badge: tr(locale, "内容与容器", "Content & layout"), widget: { title: tr(locale, "标题", "Title"), content: tr(locale, "看板标题", "Dashboard title"), fontSize: 32 } },
    { id: "basic:text", label: tr(locale, "文本", "Text"), description: tr(locale, "说明、注释或动态文本", "Description, annotation or dynamic text"), type: "text", badge: tr(locale, "内容与容器", "Content & layout"), widget: { title: tr(locale, "文本", "Text"), content: tr(locale, "文本内容", "Text content") } },
    { id: "basic:input", label: tr(locale, "输入框", "Input"), description: tr(locale, "文本查询与参数输入", "Text query and parameter input"), type: "filter", badge: tr(locale, "交互输入", "Input & interaction"), widget: { title: tr(locale, "输入框", "Input"), filterMode: "text" } },
    { id: "basic:dropdown", label: tr(locale, "下拉框", "Dropdown"), description: tr(locale, "单选下拉筛选", "Single-select dropdown filter"), type: "filter", badge: tr(locale, "交互输入", "Input & interaction"), widget: { title: tr(locale, "下拉框", "Dropdown"), filterMode: "select" } },
    { id: "basic:multi-select", label: tr(locale, "多选列表", "Multi-select"), description: tr(locale, "多值列表筛选", "Multi-value list filter"), type: "filter", badge: tr(locale, "交互输入", "Input & interaction"), widget: { title: tr(locale, "多选列表", "Multi-select"), filterMode: "multi-select" } },
    { id: "basic:date", label: tr(locale, "日期选择", "Date picker"), description: tr(locale, "日期参数与时间筛选", "Date parameters and time filtering"), type: "filter", badge: tr(locale, "交互输入", "Input & interaction"), widget: { title: tr(locale, "日期选择", "Date picker"), filterMode: "date" } },
  ];
  return BASIC_GROUPS.flatMap((group) => {
    const badge = tr(locale, group.zh, group.en);
    return [
      ...variants.filter((item) => item.badge === badge),
      ...group.types.map((type) => ({
        id: `basic:${type}`,
        label: dataWidgetTypeLabel(locale, type),
        description: type === "topology"
          ? tr(locale, "新建一个拓扑控件，随后选择或创建拓扑文档", "Add a topology control, then choose or create a topology document")
          : tr(locale, `插入通用${dataWidgetTypeLabel(locale, type)}，随后配置内容与数据`, `Insert a generic ${dataWidgetTypeLabel(locale, type)}, then configure content and data`),
        type,
        badge,
      })),
    ];
  });
}

function createResourceLibraryItems(locale: AppLocale, category: DashboardResourceCategoryKey, topologies: ReadonlyArray<{ id: string; name: string }> = []): DashboardLibraryItem[] {
  const presets = DASHBOARD_COMPONENT_PRESETS.filter((preset) => dashboardPresetResourceCategory(preset.category) === category).map((preset) => presetItem(locale, preset));
  if (category !== "spatial") return presets;
  return [
    ...topologies.map((topology) => ({
      id: `topology:${topology.id}`,
      label: topology.name,
      description: tr(locale, "插入已完成的项目拓扑，可继续编辑与绑定实时数据", "Insert this completed project topology; it remains editable and data-bindable"),
      type: "topology" as const,
      badge: tr(locale, "项目拓扑", "Project topology"),
      widget: { topologyId: topology.id, title: topology.name },
    })),
    ...presets,
  ];
}

function createAllResourceItems(locale: AppLocale, topologies: ReadonlyArray<{ id: string; name: string }> = []): DashboardLibraryItem[] {
  return DASHBOARD_RESOURCE_CATEGORIES.flatMap(({ key }) => createResourceLibraryItems(locale, key, topologies));
}

function createAllLibraryItems(locale: AppLocale, topologies: ReadonlyArray<{ id: string; name: string }> = []): DashboardLibraryItem[] {
  return [...createBasicLibraryItems(locale), ...createAllResourceItems(locale, topologies)];
}

function presetItem(locale: AppLocale, preset: DashboardComponentPreset): DashboardLibraryItem {
  const text = dashboardComponentPresetText(preset, locale);
  const badges: Record<DashboardComponentPreset["category"], [string, string]> = {
    indicator: ["业务指标", "Metric"],
    analysis: ["分析图表", "Analysis"],
    report: ["业务报表", "Report"],
    control: ["交互控件", "Control"],
    media: ["媒体监控", "Media"],
    gis: ["GIS 地图", "GIS"],
    topology: ["工业拓扑", "Topology"],
    industrial: ["工业状态", "Industrial"],
    material: ["矢量资源", "Vector asset"],
  };
  const materialBadges: Partial<Record<DashboardComponentPreset["preview"]["family"], [string, string]>> = {
    title: ["标题资源", "Titles"],
    badge: ["角标资源", "Badges"],
    frame: ["边框容器", "Frames"],
    divider: ["分隔资源", "Dividers"],
    ruler: ["标尺资源", "Rulers"],
    light: ["光带资源", "Light bands"],
    scan: ["扫描资源", "Scanning"],
    alarm: ["告警资源", "Alerts"],
  };
  const badge = preset.category === "material"
    ? materialBadges[preset.preview.family] ?? badges.material
    : badges[preset.category];
  return {
    id: `preset:${preset.id}`,
    label: text.label,
    description: text.description,
    type: preset.type,
    badge: tr(locale, ...badge),
    preset,
  };
}

/** 拖拽只传目录 ID，落点处重新读取受信目录，避免把任意 JSON 当成组件配置。 */
function beginLibraryDrag(dataTransfer: DataTransfer, itemId: string): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(DASHBOARD_LIBRARY_DRAG_TYPE, itemId);
}

export function resolveDashboardLibraryItem(locale: AppLocale, itemId: string, topologies: ReadonlyArray<{ id: string; name: string }> = []): DashboardLibraryItem | undefined {
  return createAllLibraryItems(locale, topologies).find((item) => item.id === itemId);
}
