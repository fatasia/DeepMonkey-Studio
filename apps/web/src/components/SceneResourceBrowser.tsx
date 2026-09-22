import { useState } from "react";
import { Boxes, LoaderCircle, Plus, Search, Upload } from "lucide-react";
import type { SceneOutlinerPanelProps } from "./SceneOutlinerPanel";
import { translate as tr } from "../i18n";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import { IndustrialPrefabThumbnail } from "./IndustrialPrefabThumbnail";
import { useSceneResourceDrag } from "./useSceneResourceDrag";
import { useAssetLibraryCatalog } from "./useAssetLibraryCatalog";

export function SceneResourceBrowser(props: Pick<SceneOutlinerPanelProps, "locale" | "projectAssets" | "projectModels" | "projectId" | "onLibraryImported" | "onImportModel" | "onInsertProjectModel" | "onInsertPrefab">) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"platform" | "prefab" | "project">(() => props.projectId ? "platform" : (props.projectModels?.length || props.projectAssets?.length) ? "project" : "prefab");
  const [showAll, setShowAll] = useState(false);
  const catalog = useAssetLibraryCatalog(props.projectId, props.onLibraryImported ?? (async () => {}), { dimension: "3d", featuredOnly: false });
  const assets = (props.projectAssets ?? []).map((asset) => ({ source: "asset" as const, id: asset.id, name: asset.name, fileName: asset.fileName, kind: asset.kind, thumbnailUrl: asset.thumbnailUrl, asset }));
  const models = (props.projectModels ?? []).map((model) => ({ source: "model" as const, id: model.id, name: model.name, fileName: model.format.toUpperCase(), kind: "model", thumbnailUrl: model.thumbnailUrl ?? (model.libraryOrigin?.itemId ? `/api/public/asset-library/items/${model.libraryOrigin.itemId}/thumbnail` : undefined), model }));
  const prefabs = INDUSTRIAL_PREFAB_CATALOG.map((definition) => ({ source: "prefab" as const, id: definition.id, name: tr(props.locale, definition.name, definition.englishName), fileName: definition.routeCapable ? tr(props.locale, "路线与动作", "Route & actions") : tr(props.locale, "参数与数据口", "Parameters & ports"), kind: definition.kind, thumbnailUrl: undefined, definition }));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingPrefabs = normalizedQuery ? prefabs.filter(resource => `${resource.definition.name} ${resource.definition.englishName} ${resource.kind}`.toLocaleLowerCase().includes(normalizedQuery)) : [];
  const scopedResources = scope === "prefab" ? prefabs : [...models, ...assets];
  const resources = scope === "prefab" && normalizedQuery ? matchingPrefabs : scopedResources.filter((resource) => `${resource.name} ${resource.fileName} ${resource.kind}`.toLocaleLowerCase().includes(normalizedQuery));
  const visibleResources = normalizedQuery || showAll ? resources : resources.slice(0, 24);
  const platformItems = catalog.result.items.filter((item) => item.dimension === "3d");
  const resultCount = scope === "platform" ? catalog.result.total : resources.length;
  async function insertLibraryItem(itemId: string) {
    const item = platformItems.find(item => item.id === itemId);
    if (!props.projectId || catalog.importingId || item?.publicationStatus !== "published") return;
    const existing = (props.projectModels ?? []).find((model) => model.libraryOrigin?.itemId === itemId);
    if (existing) return props.onInsertProjectModel(existing);
    const imported = await catalog.importItem(itemId);
    if (imported?.kind === "model") props.onInsertProjectModel(imported.model);
  }
  const drag = useSceneResourceDrag(props.projectId, async payload => {
    if (catalog.importingId) return;
    if (payload.source === "library") { await insertLibraryItem(payload.id); return; }
    const model = (props.projectModels ?? []).find(item => item.id === payload.id);
    if (model?.status === "ready") props.onInsertProjectModel(model);
  });
  return <section className="scene-resource-browser" aria-label={tr(props.locale, "场景资源", "Scene resources")} onDragEnd={drag.cancel}>
    <div className="scene-resource-search-row">
      <label className="component-search-input"><Search size={14} /><input value={query} onChange={(event) => { const value = event.target.value; setQuery(value); if (scope === "platform") catalog.updateSearch(value); }} aria-label={tr(props.locale, "搜索场景资源", "Search scene resources")} placeholder={tr(props.locale, "搜索模型、围栏等资源", "Search models, fences and resources")} /></label>
      <button type="button" className="scene-resource-upload" onClick={props.onImportModel} title={tr(props.locale, "本地导入", "Import local model")}><Upload size={14} /></button>
    </div>
    <nav className="scene-resource-scopes" aria-label={tr(props.locale, "资源范围", "Resource scope")}>
      <button className={scope === "platform" ? "active" : ""} onClick={() => { setScope("platform"); catalog.updateSearch(query); }}>{tr(props.locale, "平台素材", "Library")}</button>
      <button className={scope === "project" ? "active" : ""} onClick={() => setScope("project")}>{tr(props.locale, "项目资源", "Project")}</button>
      <button className={scope === "prefab" ? "active" : ""} onClick={() => setScope("prefab")}>{tr(props.locale, "工业预制体", "Prefabs")}</button>
    </nav>
    {scope === "platform" && catalog.result.categories.length > 0 && <label className="scene-resource-category">
      <span>{tr(props.locale, "平台分类", "Library category")}</span>
      <select aria-label={tr(props.locale, "平台素材分类", "Library asset category")} value={catalog.category} onChange={(event) => catalog.updateCategory(event.target.value)}>
        <option value="all">{tr(props.locale, "全部分类", "All categories")}</option>
        {catalog.result.categories.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.count}</option>)}
      </select>
    </label>}
    {scope !== "prefab" && matchingPrefabs.length > 0 && <button type="button" className="scene-resource-prefab-match" onClick={() => setScope("prefab")}>
      <Boxes size={14} /><span>{tr(props.locale, `内置预制体中有 ${matchingPrefabs.length} 项匹配`, `${matchingPrefabs.length} matching built-in prefabs`)}</span>
    </button>}
    <div className="scene-resource-count">{resultCount.toLocaleString()} {tr(props.locale, "项", "items")}</div>
    <div className="scene-resource-drop-target" onDragOver={drag.over} onDrop={event => void drag.drop(event)}>
      <Plus size={13} />{tr(props.locale, "将模型拖到这里载入当前场景", "Drag a model here to load it into the current scene")}
    </div>
    {scope === "platform" ? catalog.loading ? <div className="scene-resource-loading"><LoaderCircle className="spin" size={18} /></div> : platformItems.length > 0 ? <>
      <div className="scene-resource-grid">{platformItems.map((item) => <article className="scene-resource-card" key={item.id} draggable={Boolean(props.projectId && !catalog.importingId && item.publicationStatus === "published")} onDragStart={event => drag.begin(event, "library", item.id)} onDragEnd={drag.cancel}>
        <img src={item.thumbnailUrl} alt="" />
        <div><strong title={item.name}>{item.name}</strong><small>{item.category} · {(item.triangleCount / 1000).toFixed(0)}k</small></div>
        <button type="button" title={tr(props.locale, `载入 ${item.name}`, `Load ${item.name}`)} disabled={!props.projectId || Boolean(catalog.importingId) || item.publicationStatus !== "published"} onClick={() => void insertLibraryItem(item.id)}>{catalog.importingId === item.id ? <LoaderCircle className="spin" size={12} /> : <Plus size={12} />}</button>
      </article>)}</div>
      {catalog.result.totalPages > 1 && <div className="scene-resource-pager"><button disabled={catalog.result.page <= 1} onClick={() => catalog.setPage(catalog.result.page - 1)}>‹</button><span>{catalog.result.page}/{catalog.result.totalPages}</span><button disabled={catalog.result.page >= catalog.result.totalPages} onClick={() => catalog.setPage(catalog.result.page + 1)}>›</button></div>}
    </> : <div className="scene-resource-empty"><Boxes size={22} /><strong>{catalog.catalogError ?? tr(props.locale, "暂无匹配模型", "No matching models")}</strong></div> : visibleResources.length > 0 ? <>
      <div className="scene-resource-list">{visibleResources.map((resource) => <article className="scene-resource-row" data-model-id={resource.source === "model" ? resource.id : undefined} data-model-status={resource.source === "model" ? resource.model.status : undefined} data-resource-source={resource.source} key={`${resource.source}:${resource.id}`} draggable={resource.source === "model" && resource.model.status === "ready"} onDragStart={resource.source === "model" ? event => drag.begin(event, "model", resource.id) : undefined} onDragEnd={resource.source === "model" ? drag.cancel : undefined}>
        {resource.thumbnailUrl
          ? <img src={resource.thumbnailUrl} alt="" />
          : resource.source === "prefab"
            ? <IndustrialPrefabThumbnail definition={resource.definition} />
            : <span className={`scene-resource-icon resource-${resource.source}`}><Boxes size={16} /></span>}
        <div><strong title={resource.name}>{resource.name}</strong><small>{resource.kind} · {resource.fileName}</small></div>
        {resource.source === "prefab" ? <button type="button" onClick={() => props.onInsertPrefab(resource.definition)} title={tr(props.locale, "插入并选中可配置预制体", "Insert and select configurable prefab")}>{tr(props.locale, "插入", "Insert")}</button>
          : resource.source === "model" ? <button type="button" onClick={() => props.onInsertProjectModel(resource.model)} title={tr(props.locale, "将项目模型载入当前场景", "Load project model into this scene")}>{tr(props.locale, "载入", "Load")}</button>
            : <span className="scene-resource-use-hint">{tr(props.locale, "属性中应用", "Use in inspector")}</span>}
      </article>)}</div>
      {!normalizedQuery && resources.length > visibleResources.length && <button className="scene-resource-more" type="button" onClick={() => setShowAll(true)}>{tr(props.locale, `显示全部 ${resources.length} 项`, `Show all ${resources.length}`)}</button>}
    </> : <div className="scene-resource-empty"><Boxes size={22} /><strong>{tr(props.locale, "暂无匹配资源", "No matching resources")}</strong></div>}
    {catalog.importError && <p className="scene-resource-error" role="alert">{catalog.importError}</p>}
  </section>;
}
