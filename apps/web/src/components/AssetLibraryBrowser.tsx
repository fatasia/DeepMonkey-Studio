import { useEffect, useState } from "react";
import { Box, Check, ChevronLeft, ChevronRight, Download, Eye, Film, Mountain, Paintbrush, RefreshCw, Search, Sparkles, X } from "lucide-react";
import type { AssetLibraryDimension, AssetLibraryItem, ModelRecord, ProjectAssetRecord } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { AssetThumbnail } from "./AssetThumbnail";
import { useAssetLibraryCatalog } from "./useAssetLibraryCatalog";
import { AssetAttributionDetails } from "./AssetAttributionDetails";
import { ProjectResourcePreview } from "./ProjectResourcePreview";
import { ResourceLinkButton } from "./ResourceLinkButton";
import { readResourceBrowseTarget } from "./resourceLinks";
import { api } from "../api";

interface AssetLibraryBrowserProps {
  locale: AppLocale;
  projectId: string | undefined;
  projectModels: ModelRecord[];
  projectAssets: ProjectAssetRecord[];
  onImported: () => Promise<void>;
  onOptimize?: (modelId: string) => void;
}

export function AssetLibraryBrowser({ locale, projectId, projectModels, projectAssets, onImported, onOptimize }: AssetLibraryBrowserProps) {
  const [preview, setPreview] = useState<AssetLibraryItem | null>(null);
  const [linkedError, setLinkedError] = useState<string>();
  useEffect(() => {
    const target = readResourceBrowseTarget(window.location.hash);
    if (target?.kind !== "library") return;
    const controller = new AbortController();
    void api.getAssetLibraryItem(target.id, controller.signal).then(item => {
      if (!controller.signal.aborted) setPreview(item);
    }).catch(reason => { if (!controller.signal.aborted) setLinkedError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, []);
  const catalog = useAssetLibraryCatalog(projectId, onImported);
  const importedIds = new Set([
    ...projectModels.flatMap((model) => model.libraryOrigin?.itemId ?? model.sourceUrl.match(/\/library-(industrial-\d+)\.glb$/)?.[1] ?? []),
    ...projectAssets.flatMap((asset) => asset.libraryOrigin?.itemId ?? []),
  ]);
  const searchTerm = catalog.search.trim();
  const selectedCategory = catalog.result.categories.find((item) => item.id === catalog.category);
  const availableTotal = catalog.result.categories.reduce((sum, item) => sum + item.count, 0);

  function clearFilters() {
    catalog.updateSearch("");
    catalog.updateCategory("all");
    catalog.updateFeaturedOnly(false);
  }

  const dimensions: Array<{ id: AssetLibraryDimension | "all"; zh: string; en: string; icon: React.ReactNode }> = [
    { id: "all", zh: "全部", en: "All", icon: <Box size={14} /> },
    { id: "3d", zh: "三维模型", en: "3D models", icon: <Box size={14} /> },
    { id: "environment", zh: "环境 HDRI", en: "Environment HDRI", icon: <Mountain size={14} /> },
    { id: "material", zh: "PBR 材质", en: "PBR materials", icon: <Paintbrush size={14} /> },
  ];

  return (
    <div className="unified-assets-browser">
      {linkedError && <div className="unified-assets-action-error" role="alert">{linkedError}<button onClick={() => setLinkedError(undefined)}>{tr(locale, "关闭", "Close")}</button></div>}
      <div className="unified-assets-dimensions" role="tablist" aria-label={tr(locale, "资源维度", "Asset dimension")}>
        {dimensions.map((item) => (
          <button key={item.id} role="tab" aria-selected={catalog.dimension === item.id} className={catalog.dimension === item.id ? "active" : ""} onClick={() => catalog.updateDimension(item.id)}>
            {item.icon}<span>{tr(locale, item.zh, item.en)}</span>
          </button>
        ))}
      </div>
      <div className="unified-assets-controls">
        <div className="unified-assets-search" role="search" aria-label={tr(locale, "搜索资源", "Search assets")}>
          <Search size={15} />
          <input
            aria-label={tr(locale, "搜索资源", "Search assets")}
            value={catalog.search}
            onChange={(event) => catalog.updateSearch(event.target.value)}
            placeholder={tr(locale, "搜索模型、环境、材质…", "Search models, environments and materials…")}
          />
          {catalog.loading && <RefreshCw className="spin" size={13} />}
          {searchTerm && (
            <button
              type="button"
              className="unified-assets-search-clear"
              aria-label={tr(locale, "清空资源搜索", "Clear asset search")}
              onClick={() => catalog.updateSearch("")}
            >
              <X size={13} />
            </button>
          )}
        </div>
        <select aria-label={tr(locale, "资源分类", "Asset category")} value={catalog.category} onChange={(event) => catalog.updateCategory(event.target.value)}>
          <option value="all">{tr(locale, "全部分类", "All categories")}</option>
          {catalog.result.categories.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.count}</option>)}
        </select>
        <button className={catalog.featuredOnly ? "active" : ""} onClick={() => catalog.updateFeaturedOnly(!catalog.featuredOnly)}>
          <Sparkles size={14} />
          {tr(locale, "精选资源", "Curated")}
        </button>
      </div>

      <div className="unified-assets-summary" aria-live="polite">
        <span>
          <strong>{catalog.result.total.toLocaleString(locale)}</strong>
          {" "}
          {searchTerm
            ? tr(locale, ` 个“${searchTerm}”搜索结果`, ` results for “${searchTerm}”`)
            : selectedCategory
              ? tr(locale, ` 个${selectedCategory.name}资源`, ` ${selectedCategory.name} assets`)
              : catalog.featuredOnly
                ? tr(locale, ` 个精选资源 · 全库 ${availableTotal.toLocaleString(locale)} 个`, ` curated assets · ${availableTotal.toLocaleString(locale)} total`)
              : tr(locale, "个可用资源", "ready assets")}
        </span>
      </div>

      {catalog.importError && (
        <div className="unified-assets-action-error" role="alert">
          <span><strong>{tr(locale, "导入未完成", "Import not completed")}</strong>{catalog.importError}</span>
          <button type="button" onClick={catalog.clearImportError}>{tr(locale, "关闭", "Dismiss")}</button>
        </div>
      )}

      {catalog.catalogError && (
        <div className="unified-assets-state error">
          <strong>{tr(locale, "资源目录暂不可用", "Asset catalog unavailable")}</strong>
          <span>{catalog.catalogError}</span>
          <button className="button" onClick={() => void catalog.reload()}><RefreshCw size={14} />{tr(locale, "重试", "Retry")}</button>
        </div>
      )}

      {!catalog.catalogError && catalog.loading && catalog.result.items.length === 0 && (
        <div className="unified-assets-grid" aria-label={tr(locale, "正在加载资源", "Loading assets")}>{Array.from({ length: 12 }, (_, index) => <div className="asset-card-skeleton" key={index} />)}</div>
      )}

      {!catalog.catalogError && !catalog.loading && catalog.result.items.length === 0 && (
        <div className="unified-assets-state">
          <Box size={34} />
          <strong>{tr(locale, "没有匹配资源", "No matching assets")}</strong>
          <span>{tr(locale, "尝试更换关键词、分类或关闭精选筛选。", "Try another keyword or category, or turn off the curated filter.")}</span>
          {(searchTerm || catalog.category !== "all" || catalog.featuredOnly) && (
            <button className="button" onClick={clearFilters}>{tr(locale, "清空筛选", "Clear filters")}</button>
          )}
        </div>
      )}

      {catalog.result.items.length > 0 && (
        <div className={`unified-assets-grid ${catalog.loading ? "is-refreshing" : ""}`}>
          {catalog.result.items.map((item) => {
            const imported = importedIds.has(item.id);
            const importing = catalog.importingId === item.id;
            const deprecated = item.publicationStatus === "deprecated";
            const reviewRequired = item.publicationStatus === "review-required";
            const unavailable = deprecated || reviewRequired;
            return (
              <article className={`unified-asset-card dimension-${item.dimension}`} key={item.id}>
                <div className="unified-asset-preview">
                  <AssetThumbnail locale={locale} name={item.name} src={item.thumbnailUrl} />
                  <span className={`quality-tier ${item.qualityTier}`}>{assetQualityLabel(item, locale)}</span>
                  <span className={`asset-publication ${item.publicationStatus}`}>{publicationLabel(item.publicationStatus, locale)}</span>
                  {item.animated && <span className="asset-animation"><Film size={12} />{tr(locale, "动画", "Animated")}</span>}
                </div>
                <div className="unified-asset-copy">
                  <strong title={item.name}>{item.name}</strong>
                  <span>{[item.subcategory ?? item.category, item.style].filter(Boolean).join(" · ")}</span>
                  <small>{item.dimension === "3d" ? `${formatTriangles(item.triangleCount, locale)} · ` : `${item.mapKinds?.length ?? item.textureCount} ${tr(locale, "张贴图", "maps")} · `}{formatBytes(item.size)}</small>
                  <small>{item.license} · v{item.version}</small>
                </div>
                {item.attribution && <AssetAttributionDetails attribution={item.attribution} locale={locale} />}
                <div className="unified-asset-actions" role="group" aria-label={tr(locale, `${item.name} 操作`, `${item.name} actions`)}>
                  <button className="asset-import asset-action-button" title={tr(locale, `浏览 ${item.name}`, `Browse ${item.name}`)} aria-label={tr(locale, `浏览 ${item.name}`, `Browse ${item.name}`)} onClick={() => setPreview(item)}><Eye size={14} /><span className="asset-action-label">{tr(locale, "浏览", "Browse")}</span></button>
                  <ResourceLinkButton compact locale={locale} name={item.name} resource={projectModels.find(model => model.libraryOrigin?.itemId === item.id) ?? projectAssets.find(asset => asset.libraryOrigin?.itemId === item.id)} browse={{ kind: "library", id: item.id }} />
                  <button className="asset-import asset-action-button" title={item.dimension !== "3d" ? tr(locale, "仅支持 3D 模型", "Only available for 3D models") : tr(locale, `优化 ${item.name}`, `Optimize ${item.name}`)} aria-label={tr(locale, `优化 ${item.name}`, `Optimize ${item.name}`)} disabled={item.dimension !== "3d" || !onOptimize || !projectId || Boolean(catalog.importingId) || unavailable} onClick={async () => {
                    if (item.dimension !== "3d" || !onOptimize) return;
                    const existing = projectModels.find(model => model.libraryOrigin?.itemId === item.id);
                    if (existing) { onOptimize(existing.id); return; }
                    const result = await catalog.importItem(item.id);
                    if (result?.kind === "model") onOptimize(result.model.id);
                  }}><Sparkles size={14} /><span className="asset-action-label">{tr(locale, "优化", "Optimize")}</span></button>
                  <button className={`${imported ? "asset-imported" : "asset-import"} asset-action-button`} title={imported ? tr(locale, "已在项目", "Already in project") : tr(locale, `导入 ${item.name}`, `Import ${item.name}`)} aria-label={tr(locale, `导入 ${item.name}`, `Import ${item.name}`)} disabled={!projectId || Boolean(catalog.importingId) || imported || unavailable} onClick={() => void catalog.importItem(item.id)}>
                    {imported ? <Check size={14} /> : importing ? <RefreshCw className="spin" size={14} /> : <Download size={14} />}
                    <span className="asset-action-label">{imported
                      ? tr(locale, "已在项目", "In project")
                      : deprecated
                        ? tr(locale, "已废弃", "Deprecated")
                        : reviewRequired
                          ? tr(locale, "待复核", "Review")
                          : importing
                            ? tr(locale, "导入中", "Importing")
                            : tr(locale, "导入", "Import")}</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {catalog.result.totalPages > 1 && (
        <nav className="unified-assets-pagination" aria-label={tr(locale, "资源分页", "Asset pagination")}>
          <button disabled={catalog.result.page <= 1 || catalog.loading} onClick={() => catalog.setPage(catalog.result.page - 1)}><ChevronLeft size={15} />{tr(locale, "上一页", "Previous")}</button>
          <span>{catalog.result.page} / {catalog.result.totalPages}</span>
          <button disabled={catalog.result.page >= catalog.result.totalPages || catalog.loading} onClick={() => catalog.setPage(catalog.result.page + 1)}>{tr(locale, "下一页", "Next")}<ChevronRight size={15} /></button>
        </nav>
      )}
      {preview && <ProjectResourcePreview key={preview.id} item={preview} locale={locale} onClose={() => setPreview(null)} />}
    </div>
  );
}

function qualityLabel(tier: "light" | "standard" | "heavy", locale: AppLocale): string {
  if (tier === "light") return tr(locale, "轻量", "Light");
  if (tier === "heavy") return tr(locale, "高负载", "High load");
  return tr(locale, "标准", "Standard");
}

function assetQualityLabel(item: AssetLibraryItem, locale: AppLocale): string {
  if (item.dimension === "environment") return "HDRI";
  if (item.dimension === "material") return tr(locale, `${item.mapKinds?.length ?? item.textureCount} 图 PBR`, `${item.mapKinds?.length ?? item.textureCount}-map PBR`);
  return qualityLabel(item.qualityTier, locale);
}

function formatTriangles(count: number, locale: AppLocale): string {
  if (count >= 10_000) return locale === "zh-CN" ? `${(count / 10_000).toFixed(1)} 万面` : `${Math.round(count / 1_000)}K tris`;
  return `${count.toLocaleString(locale)} ${tr(locale, "面", "tris")}`;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function publicationLabel(status: "published" | "review-required" | "deprecated", locale: AppLocale): string {
  if (status === "published") return tr(locale, "已校验", "Verified");
  if (status === "deprecated") return tr(locale, "已废弃", "Deprecated");
  return tr(locale, "待审核", "Review required");
}
