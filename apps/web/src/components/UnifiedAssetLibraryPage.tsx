import { useEffect, useState } from "react";
import { Bot, Boxes, ChartNoAxesCombined, FolderOpen, LayoutDashboard } from "lucide-react";
import { translate as tr } from "../i18n";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import type { SceneManagerController } from "./SceneManager";
import { api } from "../api";
import { AssetLibraryBrowser } from "./AssetLibraryBrowser";
import { BuiltInAssetBrowser, type BuiltInAssetKind } from "./BuiltInAssetBrowser";
import { DASHBOARD_COMPONENT_PRESETS } from "./DashboardComponentCatalog";
import { DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";
import { ProjectAssetInventory } from "./ProjectAssetInventory";
import { readResourceBrowseTarget } from "./resourceLinks";

/** 头部概览统计的轻量目录查询:pageSize 1 只取 total,不与下方浏览器的完整列表请求争数据。 */
const LIBRARY_COUNT_QUERY = { dimension: "all" as const, page: 1, pageSize: 1 };

export function UnifiedAssetLibraryPage({ controller }: { controller: SceneManagerController }) {
  const [scope, setScope] = useState<"library" | "project">(controller.assetScope ?? "library");
  useEffect(() => { if (controller.assetScope) setScope(controller.assetScope); }, [controller.assetScope, controller.selectedAssetModelId]);
  const [kind, setKind] = useState<"model" | BuiltInAssetKind>(() => {
    const target = typeof window === "undefined" ? undefined : readResourceBrowseTarget(window.location.hash);
    return target && target.kind !== "library" ? target.kind : "model";
  });
  const { locale, onOpen, project, refreshLibraryModels, sortedScenes } = controller;
  const firstScene = sortedScenes[0];
  const projectAssetCount = (project?.models.length ?? 0) + (project?.assets?.length ?? 0);
  // 页面头部概览统计(对标帆软市场头部 + 山海鲸分类树计数徽章):模型库总数走一次轻量请求,
  // 其余三类取内置目录同步长度,均为真实计数;请求失败时显示 “—”,禁止编造占位数。
  const [libraryCount, setLibraryCount] = useState<number>();
  useEffect(() => {
    let cancelled = false;
    api.listAssetLibrary(LIBRARY_COUNT_QUERY)
      .then((page) => { if (!cancelled) setLibraryCount(page.total); })
      .catch(() => { if (!cancelled) setLibraryCount(undefined); });
    return () => { cancelled = true; };
  }, []);
  return (
    <section className="manager-page-panel asset-library-page unified-assets-page" aria-label={tr(locale, "资源", "Assets")}>
      <header className="model-library-head unified-assets-head">
        <div className="unified-assets-head-copy">
          <h2>{tr(locale, "资源", "Assets")}</h2>
        </div>
        <div className="unified-assets-scope" role="tablist" aria-label={tr(locale, "资源范围", "Asset scope")}>
          {controller.onReturnToScene && <button type="button" onClick={() => controller.onReturnToScene?.()}>{tr(locale, "返回原场景", "Return to scene")}</button>}
          <button role="tab" aria-selected={scope === "library"} className={scope === "library" ? "active" : ""} onClick={() => setScope("library")}><Boxes size={15} />{tr(locale, "公共资源", "Library")}</button>
          <button role="tab" aria-selected={scope === "project"} className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}><FolderOpen size={15} />{tr(locale, `项目资源 ${projectAssetCount}`, `Project assets ${projectAssetCount}`)}</button>
        </div>
      </header>
      {scope === "library" && (
        <nav className="unified-assets-kinds" aria-label={tr(locale, "资源类型", "Asset types")}>
          <KindButton active={kind === "model"} icon={<Boxes size={15} />} label={tr(locale, "模型与环境", "Models")} count={libraryCount} onClick={() => setKind("model")} />
          <KindButton active={kind === "2d"} icon={<ChartNoAxesCombined size={15} />} label={tr(locale, "二维资源", "2D resources")} count={DASHBOARD_COMPONENT_PRESETS.length} onClick={() => setKind("2d")} />
          <KindButton active={kind === "template"} icon={<LayoutDashboard size={15} />} label={tr(locale, "看板模板", "Templates")} count={DASHBOARD_TEMPLATES.length} onClick={() => setKind("template")} />
          <KindButton active={kind === "prefab"} icon={<Bot size={15} />} label={tr(locale, "工业预制体", "Industrial prefabs")} count={INDUSTRIAL_PREFAB_CATALOG.length} onClick={() => setKind("prefab")} />
        </nav>
      )}
      {scope === "project" ? (
        <ProjectAssetInventory controller={controller} />
      ) : kind === "model" ? (
        <AssetLibraryBrowser locale={locale} projectId={project?.id} projectModels={project?.models ?? []} projectAssets={project?.assets ?? []} onImported={refreshLibraryModels} onOptimize={controller.onOptimizer} />
      ) : (
        <BuiltInAssetBrowser
          kind={kind}
          locale={locale}
          editorAvailable={Boolean(firstScene)}
          onOpenEditor={() => { if (firstScene) void onOpen(firstScene); }}
        />
      )}
    </section>
  );
}

function KindButton({ active, icon, label, count, onClick }: { active: boolean; icon: React.ReactNode; label: string; count?: number | undefined; onClick: () => void }) {
  return (
    <button aria-pressed={active} className={active ? "active" : ""} onClick={onClick}>
      {icon}
      <span className="unified-assets-kind-label">{label}</span>
      <strong className="unified-assets-kind-count">{count === undefined ? "—" : count.toLocaleString("zh-CN")}</strong>
    </button>
  );
}
