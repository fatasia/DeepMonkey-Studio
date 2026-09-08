import { Search, Star, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { translate as tr } from "../i18n";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { DashboardTemplatePreview } from "./DashboardTemplatePreview";
import { INDUSTRY_TEMPLATE_PACKS } from "./industryTemplatePackCatalog";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import { searchDashboardTemplates } from "./dashboardTemplateSearch";
import "./DashboardTemplateLibrary.css";
import { IndustryPackCard } from "./IndustryPackCard";

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
  const panelRef = useRef<HTMLElement>(null);
  const templates = searchDashboardTemplates(locale, templateQuery, templateCategory, favoriteTemplateIds);
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
                aria-label={tr(locale, "搜索模板或行业", "Search templates or industries")}
                value={templateQuery}
                onChange={(event) => setTemplateQuery(event.target.value)}
                placeholder={tr(locale, "搜索模板或行业", "Search templates or industries")}
              />
            </label>
            <select aria-label={tr(locale, "模板分类", "Template category")} value={templateCategory} onChange={(event) => setTemplateCategory(event.target.value)}>
              <option value="all">{tr(locale, "全部行业", "All industries")}</option>
              <option value="favorites">{tr(locale, "我的收藏", "Favorites")}</option>
              <option value="packs">{tr(locale, "行业深度包", "Industry packs")}</option>
              {[...new Set(DASHBOARD_TEMPLATES.map((template) => (locale === "zh-CN" ? template.categoryZh : template.categoryEn)))].map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          <div className="dashboard-template-grid" data-category={templateCategory}>
            {templateCategory === "packs" && !packs.length && <div className="dashboard-template-empty" role="status">
              <strong>{tr(locale, "没有匹配的行业包", "No matching industry packs")}</strong>
              <button type="button" onClick={() => { setTemplateQuery(""); panelRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }}>
                {tr(locale, "查看全部行业包", "View all packs")}
              </button>
            </div>}
            {templateCategory === "packs" && packs.map((pack) => (
              <IndustryPackCard key={pack.id} pack={pack} locale={locale} page={page} onInsert={() => {
                    insertIndustryPack(pack.id);
                    setTemplateLibraryOpen(false);
                  }} />
            ))}
            {templateCategory !== "packs" && !templates.length && <div className="dashboard-template-empty" role="status">
              <strong>{tr(locale, "没有匹配的模板", "No matching templates")}</strong>
              <button type="button" onClick={() => { setTemplateQuery(""); setTemplateCategory("all"); panelRef.current?.querySelector<HTMLInputElement>("input")?.focus(); }}>
                {tr(locale, "查看全部模板", "View all templates")}
              </button>
            </div>}
            {templates.map((template) => (
                <article key={template.id}>
                  <DashboardTemplatePreview locale={locale} template={template} page={page} />
                  <div>
                    <small>{tr(locale, template.categoryZh, template.categoryEn)}</small>
                    <strong title={tr(locale, template.zh, template.en)}>{tr(locale, template.zh, template.en)}</strong>
                    <p title={tr(locale, template.descriptionZh, template.descriptionEn)}>{tr(locale, template.goalZh, template.goalEn)}</p>
                  </div>
                  <button
                    className={`dashboard-template-favorite ${favoriteTemplateIds.includes(template.id) ? "active" : ""}`}
                    aria-pressed={favoriteTemplateIds.includes(template.id)}
                    title={favoriteTemplateIds.includes(template.id) ? tr(locale, "取消收藏", "Remove favorite") : tr(locale, "收藏模板", "Favorite template")}
                    onClick={() => toggleTemplateFavorite(template.id)}
                  >
                    <Star size={13} fill={favoriteTemplateIds.includes(template.id) ? "currentColor" : "none"} />
                  </button>
                  <button
                    onClick={() => {
                      insertDashboardTemplate(template.id);
                      setTemplateLibraryOpen(false);
                    }}
                  >
                    {tr(locale, "插入当前页面", "Insert into page")}
                  </button>
                </article>
              ))}
          </div>
        </section>
      </div>
    )
  );
}
