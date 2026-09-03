import { useState } from "react";
import { Bot, Boxes, ChartNoAxesCombined, FolderOpen, LayoutDashboard } from "lucide-react";
import { translate as tr } from "../i18n";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import type { SceneManagerController } from "./SceneManager";
import { AssetLibraryBrowser } from "./AssetLibraryBrowser";
import { BuiltInAssetBrowser, type BuiltInAssetKind } from "./BuiltInAssetBrowser";
import { DASHBOARD_COMPONENT_PRESETS } from "./DashboardComponentCatalog";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { ProjectAssetInventory } from "./ProjectAssetInventory";

export function UnifiedAssetLibraryPage({ controller }: { controller: SceneManagerController }) {
  const [scope, setScope] = useState<"library" | "project">("library");
  const [kind, setKind] = useState<"model" | BuiltInAssetKind>("model");
  const { locale, onOpen, project, refreshLibraryModels, sortedScenes } = controller;
  const firstScene = sortedScenes[0];
  return (
    <section className="manager-page-panel asset-library-page unified-assets-page" aria-label={tr(locale, "资源", "Assets")}>
      <header className="model-library-head unified-assets-head">
        <div>
          <h2>{tr(locale, "资源", "Assets")}</h2>
          <p>{tr(locale, "一个入口管理二维、三维与项目资源；编辑器会自动呈现当前场景最相关的内容。", "One place for 2D, 3D and project assets, filtered automatically by editing context.")}</p>
        </div>
        <div className="unified-assets-scope" role="tablist" aria-label={tr(locale, "资源范围", "Asset scope")}>
          <button role="tab" aria-selected={scope === "library"} className={scope === "library" ? "active" : ""} onClick={() => setScope("library")}><Boxes size={15} />{tr(locale, "公共资源", "Library")}</button>
          <button role="tab" aria-selected={scope === "project"} className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}><FolderOpen size={15} />{tr(locale, `项目资源 ${project?.models.length ?? 0}`, `Project assets ${project?.models.length ?? 0}`)}</button>
        </div>
      </header>
      {scope === "library" && (
        <nav className="unified-assets-kinds" aria-label={tr(locale, "资源类型", "Asset types")}>
          <KindButton active={kind === "model"} icon={<Boxes size={15} />} label={tr(locale, "模型、环境与材质", "Models, environments & materials")} onClick={() => setKind("model")} />
          <KindButton active={kind === "2d"} icon={<ChartNoAxesCombined size={15} />} label={tr(locale, `二维资源 ${DASHBOARD_COMPONENT_PRESETS.length}`, `2D resources ${DASHBOARD_COMPONENT_PRESETS.length}`)} onClick={() => setKind("2d")} />
          <KindButton active={kind === "template"} icon={<LayoutDashboard size={15} />} label={tr(locale, `看板模板 ${DASHBOARD_TEMPLATES.length}`, `Templates ${DASHBOARD_TEMPLATES.length}`)} onClick={() => setKind("template")} />
          <KindButton active={kind === "prefab"} icon={<Bot size={15} />} label={tr(locale, `工业预制体 ${INDUSTRIAL_PREFAB_CATALOG.length}`, `Industrial prefabs ${INDUSTRIAL_PREFAB_CATALOG.length}`)} onClick={() => setKind("prefab")} />
        </nav>
      )}
      {scope === "project" ? (
        <ProjectAssetInventory controller={controller} />
      ) : kind === "model" ? (
        <AssetLibraryBrowser locale={locale} projectId={project?.id} projectModels={project?.models ?? []} projectAssets={project?.assets ?? []} onImported={refreshLibraryModels} />
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

function KindButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button aria-pressed={active} className={active ? "active" : ""} onClick={onClick}>{icon}<span>{label}</span></button>;
}
