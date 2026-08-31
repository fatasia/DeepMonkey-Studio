import { useEffect, useMemo, useState } from "react";
import { Bot, Box, ChevronLeft, ChevronRight, LayoutDashboard, Search } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import { DASHBOARD_COMPONENT_PRESETS, dashboardComponentPresetText } from "./DashboardComponentCatalog";
import { DashboardComponentPreview } from "./DashboardComponentPreview";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";

export type BuiltInAssetKind = "2d" | "template" | "prefab";

interface BuiltInAssetBrowserProps {
  kind: BuiltInAssetKind;
  locale: AppLocale;
  editorAvailable: boolean;
  onOpenEditor: () => void;
}

const PAGE_SIZE = 24;

/**
 * 统一素材中心的内置内容浏览器。这里只负责发现与导航，真正插入和参数编辑仍在对应编辑器完成，
 * 避免管理页复制一套不完整的编辑逻辑。
 */
export function BuiltInAssetBrowser({ kind, locale, editorAvailable, onOpenEditor }: BuiltInAssetBrowserProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const items = useMemo(() => createItems(kind, locale).filter((item) => !normalizedQuery || item.searchText.includes(normalizedQuery)), [kind, locale, normalizedQuery]);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const visibleItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => setPage(1), [kind, normalizedQuery]);

  return (
    <div className="unified-assets-browser built-in-assets-browser">
      <div className="unified-assets-controls built-in-assets-controls">
        <label className="unified-assets-search">
          <Search size={15} />
          <input
            aria-label={tr(locale, "搜索内置素材", "Search built-in assets")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder(kind, locale)}
          />
        </label>
      </div>

      <div className="unified-assets-summary" aria-live="polite">
        <span><strong>{items.length}</strong> {resultLabel(kind, locale)}</span>
        <i />
        <span>{tr(locale, "全部可编辑、可配置，不是静态截图或空壳模板", "Editable and configurable, not static screenshots or placeholders")}</span>
      </div>

      {visibleItems.length > 0 ? (
        <div className="unified-assets-grid built-in-assets-grid">
          {visibleItems.map((item) => (
            <article className="unified-asset-card built-in-asset-card" key={item.id}>
              <div className="unified-asset-preview built-in-asset-preview">
                {item.preview}
                <span className="built-in-asset-kind">{item.badge}</span>
              </div>
              <div className="unified-asset-copy">
                <strong title={item.name}>{item.name}</strong>
                <span title={item.description}>{item.description}</span>
                <small>{item.meta}</small>
              </div>
              <button className="asset-import" disabled={!editorAvailable} onClick={onOpenEditor}>
                {editorAvailable ? tr(locale, "进入编辑器使用", "Use in editor") : tr(locale, "请先创建场景", "Create a scene first")}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="unified-assets-state"><Box size={32} /><strong>{tr(locale, "没有匹配素材", "No matching assets")}</strong><button className="button" onClick={() => setQuery("")}>{tr(locale, "清空搜索", "Clear search")}</button></div>
      )}

      {totalPages > 1 && (
        <nav className="unified-assets-pagination" aria-label={tr(locale, "素材分页", "Asset pagination") }>
          <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={15} />{tr(locale, "上一页", "Previous")}</button>
          <span>{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>{tr(locale, "下一页", "Next")}<ChevronRight size={15} /></button>
        </nav>
      )}
    </div>
  );
}

interface BuiltInItem {
  id: string;
  name: string;
  description: string;
  badge: string;
  meta: string;
  searchText: string;
  preview: React.ReactNode;
}

function createItems(kind: BuiltInAssetKind, locale: AppLocale): BuiltInItem[] {
  if (kind === "2d") return DASHBOARD_COMPONENT_PRESETS.map((preset) => {
    const text = dashboardComponentPresetText(preset, locale);
    const badge = tr(locale, preset.category === "material" ? "二维素材" : "二维组件", preset.category === "material" ? "2D asset" : "2D component");
    const frame = preset.frame ?? { width: 320, height: 180 };
    return item({
      id: preset.id,
      name: text.label,
      description: text.description,
      badge,
      meta: tr(locale, `${frame.width} × ${frame.height} · 可绑定数据`, `${frame.width} × ${frame.height} · Data-ready`),
      preview: <DashboardComponentPreview type={preset.widget.type ?? "value"} preview={preset.preview} {...(preset.widget.decorationStyle ? { decorationStyle: preset.widget.decorationStyle } : {})} />,
    });
  });
  if (kind === "template") return DASHBOARD_TEMPLATES.map((template) => item({
    id: template.id,
    name: tr(locale, template.zh, template.en),
    description: tr(locale, template.descriptionZh, template.descriptionEn),
    badge: tr(locale, template.categoryZh, template.categoryEn),
    meta: tr(locale, `4 项核心指标 · ${template.layout.detailType}`, `4 core metrics · ${template.layout.detailType}`),
    preview: <div className="built-in-template-preview" style={{ "--template-accent": template.accent, "--template-surface": template.surface } as React.CSSProperties}><span /><i /><i /><b /><b /></div>,
  }));
  return INDUSTRIAL_PREFAB_CATALOG.map((prefab) => item({
    id: prefab.id,
    name: locale === "zh-CN" ? prefab.name : prefab.englishName,
    description: locale === "zh-CN" ? prefab.description : prefab.englishDescription,
    badge: prefabKindLabel(prefab.kind, locale),
    meta: tr(locale, `${prefab.parameters.length} 个参数 · ${prefab.actions.length} 个动作 · ${prefab.dataPorts.length} 个数据口`, `${prefab.parameters.length} params · ${prefab.actions.length} actions · ${prefab.dataPorts.length} ports`),
    preview: <div className={`built-in-prefab-preview prefab-${prefab.kind}`}>{prefab.kind === "robot-arm" ? <Bot size={42} /> : <Box size={42} />}<span>{prefab.routeCapable ? tr(locale, "路线", "ROUTE") : prefab.rigCapable ? tr(locale, "关节", "RIG") : tr(locale, "参数化", "PARAM")}</span></div>,
  }));
}

function item(value: Omit<BuiltInItem, "searchText">): BuiltInItem {
  return { ...value, searchText: `${value.name} ${value.description} ${value.badge} ${value.meta}`.toLocaleLowerCase() };
}

function searchPlaceholder(kind: BuiltInAssetKind, locale: AppLocale): string {
  if (kind === "2d") return tr(locale, "搜索图表、指标、装饰、控件…", "Search charts, metrics, decorations, controls…");
  if (kind === "template") return tr(locale, "搜索行业、业务目标或指标…", "Search industries, goals or metrics…");
  return tr(locale, "搜索机器人、输送线、AGV、设备…", "Search robots, conveyors, AGVs, equipment…");
}

function resultLabel(kind: BuiltInAssetKind, locale: AppLocale): string {
  if (kind === "2d") return tr(locale, "个二维组件与素材", "2D components and assets");
  if (kind === "template") return tr(locale, "个商业看板模板", "dashboard templates");
  return tr(locale, "个工业三维预制体", "industrial 3D prefabs");
}

function prefabKindLabel(kind: string, locale: AppLocale): string {
  const labels: Record<string, [string, string]> = {
    "robot-arm": ["工业机器人", "Robot"], conveyor: ["输送设备", "Conveyor"], agv: ["移动物流", "Mobile logistics"], person: ["人员", "People"], vehicle: ["车辆", "Vehicle"],
    "access-control": ["门禁", "Access"], display: ["显示设备", "Display"], fence: ["围栏", "Fence"], machine: ["生产设备", "Machine"], utility: ["公用工程", "Utility"],
    electrical: ["电气", "Electrical"], sensor: ["传感器", "Sensor"], camera: ["视觉监控", "Vision"], storage: ["仓储", "Storage"],
  };
  return tr(locale, ...(labels[kind] ?? ["工业预制体", "Industrial prefab"]));
}
