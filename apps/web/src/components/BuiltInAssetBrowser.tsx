import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Box, ChevronLeft, ChevronRight, Eye, Search } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import { IndustrialPrefabThumbnail } from "./IndustrialPrefabThumbnail";
import { DASHBOARD_COMPONENT_PRESETS, dashboardComponentPresetText } from "./DashboardComponentCatalog";
import { DashboardComponentPreview } from "./DashboardComponentPreview";
import { DashboardTemplatePreview } from "./DashboardTemplatePreview";
import { DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";
import { resolveTemplateGroup } from "./dashboardTemplateGroups";
import { DASHBOARD_TEMPLATE_GROUPS } from "./dashboardTemplateGroups";
import { BuiltInResourcePreview } from "./BuiltInResourcePreview";
import { ResourceLinkButton } from "./ResourceLinkButton";
import { readResourceBrowseTarget } from "./resourceLinks";
import type { DashboardTemplateTier } from "./dashboardTemplateTypes";
import { resolveTemplateTier, templateTierLabel } from "./dashboardTemplateTiers";
import { DASHBOARD_RESOURCE_CATEGORIES, dashboardPresetResourceCategory } from "./dashboardResourceCategories";
// 仅模板分支复用特征标签胶囊样式(.dashboard-template-tags);其余类无 DOM 匹配、无副作用。
import "./DashboardTemplateLibrary.css";

export type BuiltInAssetKind = "2d" | "template" | "prefab";

interface BuiltInAssetBrowserProps {
  kind: BuiltInAssetKind;
  locale: AppLocale;
  editorAvailable: boolean;
  onOpenEditor: () => void;
}

const PAGE_SIZE = 24;

/**
 * 统一“资源”页的内置内容浏览器。这里只负责发现与导航，真正插入和参数编辑仍在对应编辑器完成，
 * 避免管理页复制一套不完整的编辑逻辑。
 */
export function BuiltInAssetBrowser({ kind, locale, editorAvailable, onOpenEditor }: BuiltInAssetBrowserProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [tier, setTier] = useState<"all" | DashboardTemplateTier>("all");
  const [page, setPage] = useState(1);
  const [preview, setPreview] = useState<BuiltInItem | null>(null);
  const [linkedUnavailable, setLinkedUnavailable] = useState(false);
  useEffect(() => {
    const target = readResourceBrowseTarget(window.location.hash);
    if (target?.kind !== kind) return;
    const item = createItems(kind, locale).find(item => item.id === target.id);
    setPreview(item ?? null);
    setLinkedUnavailable(!item);
  }, [kind, locale]);
  const allItems = useMemo(() => createItems(kind, locale), [kind, locale]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  // 分类(参考帆软:大类清晰+计数徽章)与搜索叠加过滤;模板分支再叠加分层筛选(行业包/标准)。
  const items = useMemo(() => allItems.filter((item) => {
    if (category !== "all" && item.categoryKey !== category) return false;
    if (kind === "template" && tier !== "all" && resolveTemplateTier(item.id) !== tier) return false;
    return !normalizedQuery || item.searchText.includes(normalizedQuery);
  }), [allItems, category, tier, kind, normalizedQuery]);
  const categoryChips = useMemo(() => buildCategoryChips(allItems, kind, locale), [allItems, kind, locale]);
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const visibleItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => { setPage(1); setCategory("all"); setTier("all"); }, [kind]);
  useEffect(() => setPage(1), [normalizedQuery, category, tier]);

  return (
    <div className="unified-assets-browser built-in-assets-browser">
      {linkedUnavailable && <div className="unified-assets-action-error" role="alert"><span>{tr(locale, "资源不存在，请从下方资源列表重新选择", "This resource is unavailable. Choose another resource below.")}</span><button onClick={() => setLinkedUnavailable(false)}>{tr(locale, "关闭", "Close")}</button></div>}
      <div className="unified-assets-controls built-in-assets-controls">
        <div className="unified-assets-search" role="search" aria-label={tr(locale, "搜索内置资源", "Search built-in assets")}>
          <Search size={15} />
          <input
            aria-label={tr(locale, "搜索内置资源", "Search built-in assets")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder(kind, locale)}
          />
        </div>
        <button
          className="button built-in-editor-entry"
          disabled={!editorAvailable}
          onClick={onOpenEditor}
          title={editorAvailable ? tr(locale, "进入场景编辑器后，从资源面板插入", "Open the scene editor and insert from its Assets panel") : tr(locale, "请先创建场景", "Create a scene first")}
        >
          <ArrowUpRight size={15} />
          {editorAvailable ? tr(locale, "进入编辑器插入", "Open editor to insert") : tr(locale, "请先创建场景", "Create a scene first")}
        </button>
      </div>

      {(categoryChips.length > 1 || kind === "template") && (
        <div className="built-in-category-row" role="group" aria-label={tr(locale, "资源分类", "Asset categories")}>
          <button type="button" className={category === "all" ? "active" : ""} onClick={() => setCategory("all")}>
            {tr(locale, "全部", "All")}<small>{allItems.length}</small>
          </button>
          {categoryChips.map((chip) => (
            <button type="button" key={chip.key} className={category === chip.key ? "active" : ""} onClick={() => setCategory(chip.key)}>
              {chip.label}<small>{chip.count}</small>
            </button>
          ))}
          {kind === "template" && (
            <div className="built-in-tier-filter" role="group" aria-label={tr(locale, "模板分层", "Template tier")}>
              {([["all", "全部", "All"], ["industry", "行业包", "Industry pack"], ["standard", "标准", "Standard"]] as const).map(([value, zh, en]) => (
                <button type="button" key={value} className={tier === value ? "active" : ""} onClick={() => setTier(value)}>{tr(locale, zh, en)}</button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="unified-assets-summary" aria-live="polite">
        <span><strong>{items.length}</strong> {resultLabel(kind, locale)}</span>
      </div>

      {visibleItems.length > 0 ? (
        <div className="unified-assets-grid built-in-assets-grid">
          {visibleItems.map((item) => (
            <article className={`unified-asset-card built-in-asset-card built-in-${kind}`} key={item.id}>
              <div className="unified-asset-preview built-in-asset-preview">
                {item.preview}
                {kind !== "2d" && <span className="built-in-asset-kind">{item.badge}</span>}
              </div>
              <div className="unified-asset-copy">
                <strong title={item.name}>{item.name}</strong>
                <span title={item.description}>{item.description}</span>
                {item.tags && item.tags.length > 0 && <div className="dashboard-template-tags" role="list" aria-label={tr(locale, "资源特征", "Resource features")}>
                  {item.tags.map((tag) => <span key={tag.zh} role="listitem">{tr(locale, tag.zh, tag.en)}</span>)}
                </div>}
                <small>{item.meta}</small>
              </div>
              <div className="unified-asset-actions built-in-asset-actions" role="group" aria-label={tr(locale, `${item.name} 操作`, `${item.name} actions`)}>
                <button type="button" className="asset-import asset-action-button" title={tr(locale, `浏览 ${item.name}`, `Browse ${item.name}`)} aria-label={tr(locale, `浏览 ${item.name}`, `Browse ${item.name}`)} onClick={() => setPreview(item)}><Eye size={14} /><span className="asset-action-label">{tr(locale, "浏览", "Browse")}</span></button>
                <ResourceLinkButton compact locale={locale} name={item.name} browse={{ kind, id: item.id }} />
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="unified-assets-state">
          <Box size={26} />
          <strong>{tr(locale, "没有匹配资源", "No matching assets")}</strong>
          <span>{tr(locale, "换个更短的关键词，或清空搜索浏览全部资源；也可以切换上方的分类。", "Try a shorter keyword or clear the search to browse everything; you can also switch categories above.")}</span>
          <button className="button" onClick={() => setQuery("")}>{tr(locale, "清空搜索", "Clear search")}</button>
        </div>
      )}

      {totalPages > 1 && (
        <nav className="unified-assets-pagination" aria-label={tr(locale, "资源分页", "Asset pagination") }>
          <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={15} />{tr(locale, "上一页", "Previous")}</button>
          <span>{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>{tr(locale, "下一页", "Next")}<ChevronRight size={15} /></button>
        </nav>
      )}
      {preview && <BuiltInResourcePreview id={preview.id} name={preview.name} kind={kind} locale={locale} onClose={() => setPreview(null)} />}
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
  /** 分类键(参考帆软"大类清晰"组织):2D=用途大类,模板=行业 9 大类,预制体=kind。 */
  categoryKey?: string;
  /** 仅模板分支:封面下方的特征标签行(来自布局结构的诚实推导)。 */
  tags?: readonly { zh: string; en: string }[];
}

/** 2D 预设的 category 到帆软式大类(大类清晰、同级互斥)的映射。 */
function buildCategoryChips(items: BuiltInItem[], kind: BuiltInAssetKind, locale: AppLocale): Array<{ key: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.categoryKey) continue;
    counts.set(item.categoryKey, (counts.get(item.categoryKey) ?? 0) + 1);
  }
  const label = (key: string): string => {
    if (kind === "template") {
      const group = DASHBOARD_TEMPLATE_GROUPS.find((candidate) => candidate.id === key);
      return group ? tr(locale, group.zh, group.en) : tr(locale, "其他", "Other");
    }
    if (kind === "prefab") return prefabKindLabel(key, locale);
    const definition = DASHBOARD_RESOURCE_CATEGORIES.find((candidate) => candidate.key === key);
    return definition ? tr(locale, definition.zh, definition.en) : key;
  };
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count, label: label(key) }))
    .sort((left, right) => right.count - left.count);
}

function createItems(kind: BuiltInAssetKind, locale: AppLocale): BuiltInItem[] {
  if (kind === "2d") return DASHBOARD_COMPONENT_PRESETS.map((preset) => {
    const text = dashboardComponentPresetText(preset, locale);
    const badge = tr(locale, "二维资源", "2D resource");
    const frame = preset.frame ?? { width: 320, height: 180 };
    return item({
      id: preset.id,
      name: text.label,
      description: text.description,
      badge,
      categoryKey: dashboardPresetResourceCategory(preset.category),
      meta: tr(locale, `${frame.width} × ${frame.height} · 可绑定数据`, `${frame.width} × ${frame.height} · Data-ready`),
      // 缩略图必须用 preset.type（顶层合同字段）；widget.type 不在预设工厂写入范围，
      // 误读会全部静默兜底成指标卡，156 个预设缩略图因此变成同一张。
      preview: <DashboardComponentPreview type={preset.type} preview={preset.preview} showMark={false} {...(preset.widget.decorationStyle ? { decorationStyle: preset.widget.decorationStyle } : {})} />,
    });
  });
  if (kind === "template") return DASHBOARD_TEMPLATES.map((template) => {
    const tier = resolveTemplateTier(template.id);
    const detailLabels = { table: ["明细表", "Data table"], rank: ["排行榜", "Ranking"], "scroll-table": ["滚动表格", "Scrolling table"] } as const;
    const detailLabel = detailLabels[template.layout.detailType];
    return item({
      id: template.id,
      name: tr(locale, template.zh, template.en),
      description: tr(locale, template.descriptionZh, template.descriptionEn),
      badge: tr(locale, template.categoryZh, template.categoryEn),
      categoryKey: resolveTemplateGroup(template.domainId)?.id ?? "other",
      meta: tr(locale, `4 项核心指标 · ${detailLabel[0]}`, `4 core metrics · ${detailLabel[1]}`),
      // 商用分层徽章由封面左上角展示(行业包/标准);此处徽章保留行业分类,两者各司其职。
      ...(template.tags ? { tags: template.tags } : {}),
      preview: <DashboardTemplatePreview locale={locale} template={template} tier={tier} tierLabel={templateTierLabel(tier, locale)} />,
    });
  });
  return INDUSTRIAL_PREFAB_CATALOG.map((prefab) => item({
    id: prefab.id,
    name: locale === "zh-CN" ? prefab.name : prefab.englishName,
    description: locale === "zh-CN" ? prefab.description : prefab.englishDescription,
    badge: prefabKindLabel(prefab.kind, locale),
    categoryKey: prefab.kind,
    meta: tr(locale, `${prefab.parameters.length} 个参数 · ${prefab.actions.length} 个动作 · ${prefab.dataPorts.length} 个数据口`, `${prefab.parameters.length} params · ${prefab.actions.length} actions · ${prefab.dataPorts.length} ports`),
    // 大尺寸真实 3D 小样(与场景资源面板同一渲染链路),ROUTE/RIG/PARAM 徽标退居角落。
    preview: <div className={`built-in-prefab-preview prefab-${prefab.kind}`}><IndustrialPrefabThumbnail definition={prefab} /><span className="prefab-preview-badge">{prefab.routeCapable ? tr(locale, "路线", "ROUTE") : prefab.rigCapable ? tr(locale, "关节", "RIG") : tr(locale, "参数化", "PARAM")}</span></div>,
  }));
}

function item(value: Omit<BuiltInItem, "searchText">): BuiltInItem {
  const tagText = (value.tags ?? []).flatMap((tag) => [tag.zh, tag.en]).join(" ");
  return { ...value, searchText: `${value.name} ${value.description} ${value.badge} ${value.meta} ${tagText}`.toLocaleLowerCase() };
}

function searchPlaceholder(kind: BuiltInAssetKind, locale: AppLocale): string {
  if (kind === "2d") return tr(locale, "搜索图表、指标、装饰、控件…", "Search charts, metrics, decorations, controls…");
  if (kind === "template") return tr(locale, "搜索行业、业务目标或指标…", "Search industries, goals or metrics…");
  return tr(locale, "搜索机器人、输送线、AGV、设备…", "Search robots, conveyors, AGVs, equipment…");
}

function resultLabel(kind: BuiltInAssetKind, locale: AppLocale): string {
  if (kind === "2d") return tr(locale, "个二维资源", "2D resources");
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
