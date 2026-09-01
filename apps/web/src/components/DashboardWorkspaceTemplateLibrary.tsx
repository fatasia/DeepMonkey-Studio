import { Search, Star, X } from "lucide-react";
import { translate as tr } from "../i18n";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { DashboardTemplatePreview } from "./DashboardTemplatePreview";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardWorkspaceTemplateLibrary() {
  const {
    favoriteTemplateIds,
    insertDashboardTemplate,
    locale,
    setTemplateCategory,
    setTemplateLibraryOpen,
    setTemplateQuery,
    templateCategory,
    templateLibraryOpen,
    templateQuery,
    toggleTemplateFavorite,
  } = useDashboardWorkspace();
  return (
    templateLibraryOpen && (
      <div className="dashboard-template-library-backdrop" onMouseDown={() => setTemplateLibraryOpen(false)}>
        <section className="dashboard-template-library-panel" onMouseDown={(event) => event.stopPropagation()}>
          <header>
            <div>
              <span className="eyebrow">{tr(locale, "行业模板", "TEMPLATE LIBRARY")}</span>
              <strong>{tr(locale, "看板模板库", "Dashboard template library")}</strong>
              <small>
                {tr(
                  locale,
                  "模板按整组插入当前页面，可统一移动、显隐和锁定；不覆盖已有组件。",
                  "Templates insert as one group for unified move, visibility and locking; existing components stay intact.",
                )}
              </small>
            </div>
            <button title={tr(locale, "关闭", "Close")} onClick={() => setTemplateLibraryOpen(false)}>
              <X size={15} />
            </button>
          </header>
          <div className="dashboard-template-filters">
            <label className="dashboard-template-search">
              <Search size={14} />
              <input
                autoFocus
                value={templateQuery}
                onChange={(event) => setTemplateQuery(event.target.value)}
                placeholder={tr(locale, "搜索模板或行业", "Search templates or industries")}
              />
            </label>
            <select aria-label={tr(locale, "模板分类", "Template category")} value={templateCategory} onChange={(event) => setTemplateCategory(event.target.value)}>
              <option value="all">{tr(locale, "全部行业", "All industries")}</option>
              <option value="favorites">{tr(locale, "我的收藏", "Favorites")}</option>
              {[...new Set(DASHBOARD_TEMPLATES.map((template) => (locale === "zh-CN" ? template.categoryZh : template.categoryEn)))].map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>
          <div className="dashboard-template-grid">
            {DASHBOARD_TEMPLATES.filter((template) => {
              const query = templateQuery.trim().toLocaleLowerCase();
              const category = locale === "zh-CN" ? template.categoryZh : template.categoryEn;
              const categoryMatch = templateCategory === "all" || templateCategory === category || (templateCategory === "favorites" && favoriteTemplateIds.includes(template.id));
              const searchableText = [
                template.zh,
                template.en,
                template.categoryZh,
                template.categoryEn,
                template.goalZh,
                template.goalEn,
                template.descriptionZh,
                template.descriptionEn,
                ...template.metrics.flatMap((metric) => [metric.zh, metric.en]),
              ].join(" ").toLocaleLowerCase();
              return categoryMatch && (!query || searchableText.includes(query));
            })
              .sort((left, right) => Number(favoriteTemplateIds.includes(right.id)) - Number(favoriteTemplateIds.includes(left.id)))
              .map((template) => (
                <article key={template.id}>
                  <DashboardTemplatePreview locale={locale} template={template} />
                  <div>
                    <small>{tr(locale, template.categoryZh, template.categoryEn)}</small>
                    <strong>{tr(locale, template.zh, template.en)}</strong>
                    <p>{tr(locale, template.descriptionZh, template.descriptionEn)}</p>
                  </div>
                  <button
                    className={`dashboard-template-favorite ${favoriteTemplateIds.includes(template.id) ? "active" : ""}`}
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
