import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { BarChart3, Box, ChartNoAxesCombined, FolderOpen, Image, LayoutTemplate, Plus, Search, SlidersHorizontal, Upload, X } from "lucide-react";
import type { DashboardDataWidgetConfig, SceneDashboardWidgetType } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import {
  DASHBOARD_COMPONENT_PRESETS,
  dashboardComponentPresetText,
  type DashboardComponentPreset,
} from "./DashboardComponentCatalog";
import { DashboardComponentPreview } from "./DashboardComponentPreview";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { DATA_WIDGET_CATEGORIES, DECORATION_ASSETS, dataWidgetTypeLabel } from "./dashboardWorkspaceModel";

type LibraryTab = "chart" | "control" | "media" | "threeD" | "resource";

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
  searchInputRef: RefObject<HTMLInputElement | null>;
  onOpenTemplates: () => void;
  onAddSceneViewport: () => void;
  onAddWidget: (type: SceneDashboardWidgetType, widget?: Partial<DashboardDataWidgetConfig>, frame?: DashboardComponentPreset["frame"], nameHint?: string) => void;
}

const TAB_ICONS = {
  chart: BarChart3,
  control: SlidersHorizontal,
  media: Image,
  threeD: Box,
  resource: FolderOpen,
} as const;

/**
 * 二维组件浏览器只负责“发现与插入”，数据绑定和样式编辑继续由右侧检查器承担。
 * 这样资源库保持轻量，也避免在同一面板重复一套配置逻辑。
 */
export function DashboardComponentLibrary({ locale, projectId, sceneAvailable, searchInputRef, onOpenTemplates, onAddSceneViewport, onAddWidget }: DashboardComponentLibraryProps) {
  const [activeTab, setActiveTab] = useState<LibraryTab>("chart");
  const [query, setQuery] = useState("");
  const [recentlyAddedId, setRecentlyAddedId] = useState<string>();
  const feedbackTimer = useRef<number | undefined>(undefined);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const [uploadingKind, setUploadingKind] = useState<"image" | "video">();
  const [uploadError, setUploadError] = useState<string>();
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const items = useMemo(() => createLibraryItems(locale, activeTab), [activeTab, locale]);
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return items;
    return createAllLibraryItems(locale).filter((item) => `${item.label} ${item.description} ${item.badge}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [items, locale, normalizedQuery]);
  const groupedItems = useMemo(() => groupLibraryItems(filteredItems), [filteredItems]);
  const sceneSearchText = tr(locale, "三维场景视口 嵌入场景 业务联动 3D", "3D scene viewport embed scene business linkage").toLocaleLowerCase();
  const showSceneCard = (!normalizedQuery && activeTab === "threeD") || Boolean(normalizedQuery && sceneSearchText.includes(normalizedQuery));
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
        <button className="dashboard-library-template-button" title={tr(locale, `行业模板（${DASHBOARD_TEMPLATES.length}）`, `Templates (${DASHBOARD_TEMPLATES.length})`)} onClick={onOpenTemplates}>
          <LayoutTemplate size={14} />
          {tr(locale, "模板", "Templates")}
        </button>
      </div>

      {!normalizedQuery && (
        <div className="dashboard-library-tabs" role="tablist" aria-label={tr(locale, "资源分类", "Resource categories")}>
          {(["chart", "control", "media", "threeD", "resource"] as const).map((tab) => {
            const Icon = TAB_ICONS[tab];
            const labels: Record<LibraryTab, [string, string]> = {
              chart: ["图表", "Charts"],
              control: ["控件", "Controls"],
              media: ["媒体", "Media"],
              threeD: ["3D", "3D"],
              resource: ["资源", "Assets"],
            };
            return (
              <button role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "active" : ""} key={tab} onClick={() => setActiveTab(tab)}>
                <Icon size={13} />
                {tr(locale, ...labels[tab])}
              </button>
            );
          })}
        </div>
      )}

      {!normalizedQuery && activeTab === "media" && (
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

function createLibraryItems(locale: AppLocale, tab: LibraryTab): DashboardLibraryItem[] {
  if (tab === "chart") {
    return DASHBOARD_COMPONENT_PRESETS.filter((preset) => ["indicator", "analysis", "report", "gis", "industrial"].includes(preset.category)).map((preset) => presetItem(locale, preset));
  }
  if (tab === "control") {
    return [
      ...DASHBOARD_COMPONENT_PRESETS.filter((preset) => preset.category === "control").map((preset) => presetItem(locale, preset)),
      ...DATA_WIDGET_CATEGORIES.flatMap((category) =>
      category.types
        .filter((type) => ["filter", "text", "shape"].includes(type))
        .map((type) => ({
          id: `basic:${type}`,
          label: dataWidgetTypeLabel(locale, type),
          description: tr(locale, `创建${dataWidgetTypeLabel(locale, type)}，随后配置数据与交互`, `Add ${dataWidgetTypeLabel(locale, type)}, then configure data and interactions`),
          type,
          badge: tr(locale, category.zh, category.en),
        })),
      ),
    ];
  }
  if (tab === "media") {
    return [
      ...DASHBOARD_COMPONENT_PRESETS.filter((preset) => ["media", "topology"].includes(preset.category)).map((preset) => presetItem(locale, preset)),
      ...DATA_WIDGET_CATEGORIES.flatMap((category) => category.types)
        .filter((type) => ["image", "video", "monitor", "url", "topology"].includes(type))
        .map((type) => ({
          id: `basic:${type}`,
          label: dataWidgetTypeLabel(locale, type),
          description: tr(locale, `插入${dataWidgetTypeLabel(locale, type)}`, `Insert ${dataWidgetTypeLabel(locale, type)}`),
          type,
          badge: tr(locale, "媒体", "Media"),
        })),
    ];
  }
  if (tab === "threeD") {
    return DATA_WIDGET_CATEGORIES.flatMap((category) => category.types)
      .filter((type) => type === "unity")
      .map((type) => ({
        id: `basic:${type}`,
        label: dataWidgetTypeLabel(locale, type),
        description: tr(locale, "嵌入 Unity 内容", "Embed Unity content"),
        type,
        badge: "3D",
      }));
  }
  return [
    ...DASHBOARD_COMPONENT_PRESETS.filter((preset) => preset.category === "material").map((preset) => presetItem(locale, preset)),
    ...DECORATION_ASSETS.map((asset) => ({
      id: `decoration:${asset.style}`,
      label: tr(locale, asset.zh, asset.en),
      description: tr(locale, "可组合、可缩放的装饰资源", "Composable and resizable decoration asset"),
      type: "decoration" as const,
      badge: tr(locale, "矢量资源", "Vector asset"),
      widget: {
        decorationStyle: asset.style,
        title: tr(locale, asset.zh, asset.en),
        content: asset.style.includes("title") || asset.style === "title" ? tr(locale, "看板标题", "Dashboard title") : "",
      },
    })),
  ];
}

function createAllLibraryItems(locale: AppLocale): DashboardLibraryItem[] {
  const unique = new Map<string, DashboardLibraryItem>();
  for (const tab of ["chart", "control", "media", "threeD", "resource"] as const) {
    for (const item of createLibraryItems(locale, tab)) unique.set(item.id, item);
  }
  return [...unique.values()];
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

export function resolveDashboardLibraryItem(locale: AppLocale, itemId: string): DashboardLibraryItem | undefined {
  return createAllLibraryItems(locale).find((item) => item.id === itemId);
}
