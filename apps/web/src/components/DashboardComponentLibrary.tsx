import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Box, ChartNoAxesCombined, LayoutDashboard, Plus, Search, Shapes, Sparkles, X } from "lucide-react";
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

type LibraryTab = "recommended" | "basic" | "material";

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
  connected: boolean;
  sceneAvailable: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onOpenTemplates: () => void;
  onAddSceneViewport: () => void;
  onAddWidget: (type: SceneDashboardWidgetType, widget?: Partial<DashboardDataWidgetConfig>, frame?: DashboardComponentPreset["frame"]) => void;
}

const TAB_ICONS = {
  recommended: Sparkles,
  basic: Shapes,
  material: Box,
} as const;

/**
 * 二维组件浏览器只负责“发现与插入”，数据绑定和样式编辑继续由右侧检查器承担。
 * 这样素材库保持轻量，也避免在同一面板重复一套配置逻辑。
 */
export function DashboardComponentLibrary({ locale, connected, sceneAvailable, searchInputRef, onOpenTemplates, onAddSceneViewport, onAddWidget }: DashboardComponentLibraryProps) {
  const [activeTab, setActiveTab] = useState<LibraryTab>("recommended");
  const [query, setQuery] = useState("");
  const [recentlyAddedId, setRecentlyAddedId] = useState<string>();
  const feedbackTimer = useRef<number | undefined>(undefined);
  const normalizedQuery = query.trim().toLocaleLowerCase();

  const items = useMemo(() => createLibraryItems(locale, activeTab), [activeTab, locale]);
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return items;
    return createAllLibraryItems(locale).filter((item) => `${item.label} ${item.description} ${item.badge}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [items, locale, normalizedQuery]);
  const groupedItems = useMemo(() => groupLibraryItems(filteredItems), [filteredItems]);
  const sceneSearchText = tr(locale, "三维场景视口 嵌入场景 业务联动 3D", "3D scene viewport embed scene business linkage").toLocaleLowerCase();
  const showSceneCard = (!normalizedQuery && activeTab === "recommended") || Boolean(normalizedQuery && sceneSearchText.includes(normalizedQuery));
  const resultCount = filteredItems.length + (showSceneCard ? 1 : 0);

  useEffect(() => () => window.clearTimeout(feedbackTimer.current), []);

  function addItem(item: DashboardLibraryItem) {
    onAddWidget(item.type, item.preset?.widget ?? item.widget, item.preset?.frame);
    setRecentlyAddedId(item.id);
    window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setRecentlyAddedId(undefined), 1300);
  }

  return (
    <div className="dashboard-library-browser">
      <button className="dashboard-library-template-entry" onClick={onOpenTemplates}>
        <span className="dashboard-library-template-icon">
          <LayoutDashboard size={17} />
        </span>
        <span>
          <strong>{tr(locale, "从行业模板开始", "Start from a template")}</strong>
          <small>{tr(locale, "完整布局，可继续编辑", "Complete, editable layouts")}</small>
        </span>
        <em>{DASHBOARD_TEMPLATES.length}</em>
      </button>

      <div className="dashboard-library-heading">
        <span>
          <strong>{tr(locale, "组件素材", "Components")}</strong>
          <small>{tr(locale, "点击插入，或拖到画布定位", "Click to insert or drag onto canvas")}</small>
        </span>
        <i className={connected ? "online" : "offline"}>{connected ? tr(locale, "数据在线", "Data online") : tr(locale, "离线编辑", "Offline edit")}</i>
      </div>

      <label className="dashboard-library-search">
        <Search size={14} />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tr(locale, "搜索图表、指标、素材…", "Search charts, metrics, assets…")}
        />
        <kbd>Ctrl F</kbd>
      </label>

      {!normalizedQuery && (
        <div className="dashboard-library-tabs" role="tablist" aria-label={tr(locale, "组件分类", "Component categories")}>
          {(["recommended", "basic", "material"] as const).map((tab) => {
            const Icon = TAB_ICONS[tab];
            const labels: Record<LibraryTab, [string, string]> = {
              recommended: ["精选", "Featured"],
              basic: ["基础", "Basic"],
              material: ["素材", "Assets"],
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
          >
            <DashboardComponentPreview type="scene" />
            <span>
              <strong>{tr(locale, "三维场景视口", "3D scene viewport")}</strong>
              <small>
                {sceneAvailable ? tr(locale, "嵌入场景并配置业务联动", "Embed a scene with business linkage") : tr(locale, "请先创建三维场景", "Create a 3D scene first")}
              </small>
              <em>{tr(locale, "3D 联动", "3D linkage")}</em>
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
                    <small>{item.description}</small>
                    <em>{recentlyAddedId === item.id ? tr(locale, "已插入画布", "Added to canvas") : item.badge}</em>
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
            <small>{tr(locale, "换个关键词，或清空搜索查看全部素材。", "Try another keyword or clear the search.")}</small>
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
  if (tab === "recommended") {
    return DASHBOARD_COMPONENT_PRESETS.filter((preset) => preset.category !== "material").map((preset) => presetItem(locale, preset));
  }
  if (tab === "basic") {
    return DATA_WIDGET_CATEGORIES.flatMap((category) =>
      category.types
        .filter((type) => type !== "decoration")
        .map((type) => ({
          id: `basic:${type}`,
          label: dataWidgetTypeLabel(locale, type),
          description: tr(locale, `创建${dataWidgetTypeLabel(locale, type)}，随后配置数据与交互`, `Add ${dataWidgetTypeLabel(locale, type)}, then configure data and interactions`),
          type,
          badge: tr(locale, category.zh, category.en),
        })),
    );
  }
  return [
    ...DASHBOARD_COMPONENT_PRESETS.filter((preset) => preset.category === "material").map((preset) => presetItem(locale, preset)),
    ...DECORATION_ASSETS.map((asset) => ({
      id: `decoration:${asset.style}`,
      label: tr(locale, asset.zh, asset.en),
      description: tr(locale, "可组合、可缩放的装饰素材", "Composable and resizable decoration asset"),
      type: "decoration" as const,
      badge: tr(locale, "矢量素材", "Vector asset"),
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
  for (const tab of ["recommended", "basic", "material"] as const) {
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
    material: ["矢量素材", "Vector asset"],
  };
  const materialBadges: Partial<Record<DashboardComponentPreset["preview"]["family"], [string, string]>> = {
    title: ["标题素材", "Titles"],
    badge: ["角标素材", "Badges"],
    frame: ["边框容器", "Frames"],
    divider: ["分隔素材", "Dividers"],
    ruler: ["标尺素材", "Rulers"],
    light: ["光带素材", "Light bands"],
    scan: ["扫描素材", "Scanning"],
    alarm: ["告警素材", "Alerts"],
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
