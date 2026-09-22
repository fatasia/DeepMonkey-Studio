import { Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { translate as tr } from "../i18n";
import type { AppLocale } from "../i18n";
import type { DashboardPageDocument } from "@bim-studio/contracts";
import type { DashboardTemplateDefinition } from "./dashboardTemplateTypes";
import { DashboardTemplatePreview } from "./DashboardTemplatePreview";
import { INDUSTRY_PACK_ISSUES, INDUSTRY_TEMPLATE_PACKS } from "./industryTemplatePackCatalog";
import { DASHBOARD_TEMPLATE_GROUPS } from "./dashboardTemplateGroups";
import { DASHBOARD_TEMPLATE_SUITES, suiteStats } from "./dashboardTemplateSuites";
import { rankRecommendedTemplates, resolveTemplateTier, templateTierLabel } from "./dashboardTemplateTiers";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import { searchDashboardTemplates } from "./dashboardTemplateSearch";
import { DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";
import "./DashboardTemplateLibrary.css";
import { IndustryPackCard } from "./IndustryPackCard";

/** 类型筛选:全部(推荐/最新双分区)/ 推荐(精选排序)/ 行业包 / 我的收藏。 */
type TemplateTypeFilter = "all" | "recommended" | "packs" | "favorites";

export function DashboardWorkspaceTemplateLibrary() {
  const {
    favoriteTemplateIds,
    insertDashboardTemplate,
    insertIndustryPack,
    locale,
    page,
    setTemplateCategory,
    setTemplateLibraryOpen,
    setTemplateQuery,
    templateCategory,
    templateLibraryOpen,
    templateQuery,
    toggleTemplateFavorite,
  } = useDashboardWorkspace();
  const [typeFilter, setTypeFilter] = useState<TemplateTypeFilter>("all");
  const [suiteId, setSuiteId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const templates = useMemo(
    () => searchDashboardTemplates(locale, templateQuery, templateCategory, favoriteTemplateIds),
    [locale, templateQuery, templateCategory, favoriteTemplateIds],
  );
  const suite = DASHBOARD_TEMPLATE_SUITES.find((candidate) => candidate.id === suiteId);
  const scoped = useMemo(() => {
    const base = typeFilter === "favorites" ? templates.filter((template) => favoriteTemplateIds.includes(template.id)) : templates;
    return suite ? base.filter((template) => template.suite === suite.id) : base;
  }, [templates, typeFilter, favoriteTemplateIds, suite]);
  const recommended = useMemo(() => rankRecommendedTemplates(scoped).slice(0, 8), [scoped]);
  const suiteCards = useMemo(
    () => DASHBOARD_TEMPLATE_SUITES.map((candidate) => ({ suite: candidate, stats: suiteStats(candidate, DASHBOARD_TEMPLATES) })),
    [],
  );
  const packs = useMemo(() => {
    const normalized = templateQuery.trim().toLocaleLowerCase();
    return INDUSTRY_TEMPLATE_PACKS.filter(pack => !normalized
      || [pack.titleZh, pack.titleEn, pack.summaryZh, pack.summaryEn, ...pack.pages.flatMap((pageItem) => [pageItem.nameZh, pageItem.nameEn])].join(" ").toLocaleLowerCase().includes(normalized));
  }, [templateQuery]);
  useEffect(() => {
    if (!templateLibraryOpen) return;
    const previous = document.activeElement;
    panelRef.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [templateLibraryOpen]);
  // 封面缩略图统一用标准 1920×1080 基准(对标外部参考/外部参考市场卡的统一 16:9 封面),
  // 插入仍按当前画布真实尺寸适配(insertDashboardTemplate → createDashboardTemplateNodes)。
  const cardProps = { locale, favoriteTemplateIds, onToggle: toggleTemplateFavorite, onInsert: (id: string) => { insertDashboardTemplate(id); setTemplateLibraryOpen(false); } };
  return (
    templateLibraryOpen && (
      <div className="dashboard-template-library-backdrop" onMouseDown={() => setTemplateLibraryOpen(false)}>
        <section ref={panelRef} className="dashboard-template-library-panel" role="dialog" aria-modal="true"
          aria-label={tr(locale, "看板模板库", "Dashboard template library")}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.defaultPrevented || event.nativeEvent.isComposing) return;
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setTemplateLibraryOpen(false); }
            if (event.key !== "Tab") return;
            const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']")]
              .filter(element => element.getClientRects().length > 0);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }}>
          <header>
            <div>
              <strong>{tr(locale, "看板模板库", "Dashboard template library")}</strong>
            </div>
            <button title={tr(locale, "关闭", "Close")} onClick={() => setTemplateLibraryOpen(false)}>
              <X size={15} />
            </button>
          </header>
          <div className="dashboard-template-filters">
            <label className="dashboard-template-search">
              <Search size={14} />
              <input
                aria-label={tr(locale, "搜索模板、行业或标签", "Search templates, industries or tags")}
                value={templateQuery}
                onChange={(event) => setTemplateQuery(event.target.value)}
                placeholder={tr(locale, "搜索模板、行业或标签", "Search templates, industries or tags")}
              />
            </label>
            <select aria-label={tr(locale, "行业分组", "Industry group")} value={templateCategory} onChange={(event) => setTemplateCategory(event.target.value)}>
              <option value="all">{tr(locale, "全部行业", "All industries")}</option>
              {DASHBOARD_TEMPLATE_GROUPS.map((group) => (
                <option key={group.id} value={group.id}>{tr(locale, group.zh, group.en)}</option>
              ))}
            </select>
            <select aria-label={tr(locale, "模板类型", "Template type")} value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as TemplateTypeFilter)}>
              <option value="all">{tr(locale, "全部类型", "All types")}</option>
              <option value="recommended">{tr(locale, "推荐", "Recommended")}</option>
              <option value="packs">{tr(locale, "行业包", "Industry packs")}</option>
              <option value="favorites">{tr(locale, "我的收藏", "Favorites")}</option>
            </select>
          </div>
          {/* 面板是三行 grid(header/筛选/内容);所有内容分支包进同一滚动容器,避免破坏行模板。 */}
          <div className="dashboard-template-body">
            {/* 主题套件入口横排(外部参考 visuals 页套件层的对标):色族聚合 + 量化徽章,点击过滤。 */}
            <div className="dashboard-template-suites" role="group" aria-label={tr(locale, "主题套件", "Theme suites")}>
              {suiteCards.map(({ suite: candidate, stats }) => (
                <button key={candidate.id} type="button" aria-pressed={suiteId === candidate.id}
                  title={tr(locale, candidate.descriptionZh, candidate.descriptionEn)}
                  className={`dashboard-template-suite${suiteId === candidate.id ? " active" : ""}`}
                  style={{ "--suite-accent": candidate.accent, "--suite-surface": candidate.surface } as CSSProperties}
                  onClick={() => setSuiteId((current) => (current === candidate.id ? null : candidate.id))}>
                  <strong>{tr(locale, candidate.zh, candidate.en)}</strong>
                  <span>{tr(locale, candidate.descriptionZh, candidate.descriptionEn)}</span>
                  <em>{stats.count} {tr(locale, "模板", "templates")} · {stats.chartKinds} {tr(locale, "类主图表", "chart families")}</em>
                </button>
              ))}
            </div>
            {suite && (
              <p className="dashboard-template-suite-active">
                <span>{tr(locale, "主题套件", "Theme suite")}：<strong>{tr(locale, suite.zh, suite.en)}</strong></span>
                <button type="button" onClick={() => setSuiteId(null)}>{tr(locale, "退出套件", "Exit suite")}</button>
              </p>
            )}
            {typeFilter === "packs" ? (
              <div className="dashboard-template-grid" data-category="packs">
                {INDUSTRY_PACK_ISSUES.length > 0 && <p role="alert" title={INDUSTRY_PACK_ISSUES.join("\n")}>
                  {tr(locale, "部分行业包校验失败，已暂停导入。", "Some industry packs failed validation and cannot be imported.")}
                </p>}
                {!packs.length && <div className="dashboard-template-empty" role="status">
                  <strong>{tr(locale, "没有匹配的行业包", "No matching industry packs")}</strong>
                  <button type="button" onClick={() => { setTemplateQuery(""); panelRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }}>
                    {tr(locale, "查看全部行业包", "View all packs")}
                  </button>
                </div>}
                {packs.map((pack) => (
                  <IndustryPackCard key={pack.id} pack={pack} locale={locale} page={page} onInsert={() => {
                    insertIndustryPack(pack.id);
                    setTemplateLibraryOpen(false);
                  }} />
                ))}
              </div>
            ) : scoped.length ? (
              typeFilter === "all" ? (
                <>
                  <section className="dashboard-template-section dashboard-template-section-recommended" aria-label={tr(locale, "推荐模板", "Recommended templates")}>
                    <header className="dashboard-template-section-head">
                      <strong>{tr(locale, "推荐", "Recommended")}</strong>
                      <span>{tr(locale, "行业包优先 · 按内容完整度精选", "Packs first · ranked by completeness")}</span>
                    </header>
                    <div className="dashboard-template-row">
                      {recommended.map((template) => <TemplateCard key={template.id} template={template} {...cardProps} />)}
                    </div>
                  </section>
                  <section className="dashboard-template-section" aria-label={tr(locale, "最新模板", "Newest templates")}>
                    <header className="dashboard-template-section-head">
                      <strong>{tr(locale, "最新", "Newest")}</strong>
                      <span>{tr(locale, "全部模板 · 按目录定义顺序", "All templates · catalog order")}</span>
                    </header>
                    <div className="dashboard-template-grid">
                      {scoped.map((template) => <TemplateCard key={template.id} template={template} {...cardProps} />)}
                    </div>
                  </section>
                </>
              ) : (
                <div className="dashboard-template-grid">
                  {(typeFilter === "recommended" ? rankRecommendedTemplates(scoped) : scoped).map((template) => <TemplateCard key={template.id} template={template} {...cardProps} />)}
                </div>
              )
            ) : (
              <div className="dashboard-template-empty" role="status">
                <strong>{tr(locale, "没有匹配的模板", "No matching templates")}</strong>
                <button type="button" onClick={() => { setTemplateQuery(""); setTemplateCategory("all"); setTypeFilter("all"); panelRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }}>
                  {tr(locale, "查看全部模板", "View all templates")}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    )
  );
}

interface TemplateCardProps {
  template: DashboardTemplateDefinition;
  locale: AppLocale;
  favoriteTemplateIds: readonly string[];
  onToggle(templateId: string): void;
  onInsert(templateId: string): void;
}

/** 卡片信息结构对齐参照规格:封面(带分层徽章)→ 标题 → 行业标签 → 描述 → 特征标签行。 */
function TemplateCard({ template, locale, favoriteTemplateIds, onToggle, onInsert }: TemplateCardProps) {
  const tier = resolveTemplateTier(template.id);
  const favorite = favoriteTemplateIds.includes(template.id);
  return (
    <article>
      <DashboardTemplatePreview locale={locale} template={template} tier={tier} tierLabel={templateTierLabel(tier, locale)} />
      <div>
        <small>{tr(locale, template.categoryZh, template.categoryEn)}</small>
        <strong title={tr(locale, template.zh, template.en)}>{tr(locale, template.zh, template.en)}</strong>
        <p title={tr(locale, template.descriptionZh, template.descriptionEn)}>{tr(locale, template.goalZh, template.goalEn)}</p>
        <div className="dashboard-template-tags" role="list" aria-label={tr(locale, "模板特征", "Template features")}>
          {(template.tags ?? []).map((tag) => <span key={tag.zh} role="listitem">{tr(locale, tag.zh, tag.en)}</span>)}
        </div>
      </div>
      <button
        className={`dashboard-template-favorite ${favorite ? "active" : ""}`}
        aria-pressed={favorite}
        title={favorite ? tr(locale, "取消收藏", "Remove favorite") : tr(locale, "收藏模板", "Favorite template")}
        onClick={() => onToggle(template.id)}
      >
        <Star size={13} fill={favorite ? "currentColor" : "none"} />
      </button>
      <button onClick={() => onInsert(template.id)}>
        {tr(locale, "插入当前页面", "Insert into page")}
      </button>
    </article>
  );
}
