import { Box, Image as ImageIcon, Mountain, Paintbrush, Pencil, Search, Trash2, Video, WandSparkles } from "lucide-react";
import type { ConversionStatus } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { SceneManagerController } from "./SceneManager";
import { ProjectResourceGovernancePanel, ResourceUsageBadge } from "./ProjectResourceGovernancePanel";
import { ProjectAssetToolbar } from "./ProjectAssetToolbar";

export function ProjectAssetInventory({ controller }: { controller: SceneManagerController }) {
  const {
    assetSearch, assetTab, deleteLibraryAsset, deleteLibraryModel, locale, modelLibraryBusy, normalizedSearch,
    project, renameLibraryItem, resourceGovernance, setAssetSearch, setAssetTab, setParametricSourceModel,
    setParametricWorkbenchOpen, visibleAppearanceAssets, visibleImages, visibleModels, visibleVideos,
  } = controller;
  return (
    <div className="project-asset-inventory">
      <ProjectResourceGovernancePanel locale={locale} report={resourceGovernance} />
      <ProjectAssetToolbar controller={controller} />
      <div className="asset-library-filter">
        <div>
          {(["all", "model", "image", "video", "environment", "pbr-material"] as const).map((tab) => (
            <button key={tab} className={assetTab === tab ? "active" : ""} onClick={() => setAssetTab(tab)}>
              {assetTabLabel(tab, project?.models.length ?? 0, project?.assets ?? [], locale)}
            </button>
          ))}
        </div>
        <label><Search size={14} /><input value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} placeholder={tr(locale, "搜索项目素材", "Search project assets")} /></label>
      </div>
      <div className="model-library-list">
        {visibleModels.map((model) => (
          <article className="model-library-item" key={model.id}>
            <div className="model-library-format">{model.format.toUpperCase()}</div>
            <div className="model-library-info">
              <strong title={model.name}>{model.name}</strong>
              <span>{formatBytes(model.size)} · {new Date(model.updatedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span>
              {model.generation?.kind === "parametric" && <small>{tr(locale, `参数化资源 · v${model.generation.revision} · ${model.generation.build.triangleCount.toLocaleString("zh-CN")} 三角面`, `Parametric asset · v${model.generation.revision} · ${model.generation.build.triangleCount.toLocaleString("en-US")} triangles`)}</small>}
              {model.status !== "ready" && <small title={model.message}>{model.message}</small>}
            </div>
            <div className="model-library-state">
              <span className={`model-status model-status-${model.status}`}>{statusLabel(model.status, locale)}</span>
              <ResourceUsageBadge locale={locale} resource={resourceGovernance.resources.find((resource) => resource.kind === "model" && resource.id === model.id)} />
              {model.status === "processing" && <progress max={100} value={model.progress} aria-label={`${tr(locale, "转换进度", "Conversion progress")} ${model.progress}%`} />}
            </div>
            {model.generation?.kind === "parametric" && <button className="manager-icon-button" title={tr(locale, "修改参数并创建新版本", "Edit parameters as a new revision")} disabled={modelLibraryBusy} onClick={() => { setParametricSourceModel(model); setParametricWorkbenchOpen(true); }}><WandSparkles size={14} /></button>}
            <button className="manager-icon-button" title={tr(locale, "重命名", "Rename")} disabled={modelLibraryBusy} onClick={() => void renameLibraryItem(model, "model")}><Pencil size={14} /></button>
            <button className="manager-icon-button danger" title={tr(locale, "删除模型", "Delete model")} disabled={modelLibraryBusy} onClick={() => void deleteLibraryModel(model)}><Trash2 size={15} /></button>
          </article>
        ))}
        {visibleImages.map((asset) => (
          <article className="model-library-item asset-image-item" key={asset.id}>
            <div className="asset-image-preview"><img src={asset.url} alt="" loading="lazy" /></div>
            <AssetInfo name={asset.name} size={asset.size} updatedAt={asset.updatedAt} locale={locale} hint={tr(locale, "可用于二维看板图片组件", "Ready for dashboard image widgets")} />
            <div className="model-library-state"><span className="model-status model-status-ready">{tr(locale, "可使用", "Ready")}</span><ResourceUsageBadge locale={locale} resource={resourceGovernance.resources.find((resource) => resource.kind === "media" && resource.id === asset.id)} /></div>
            <button className="manager-icon-button" title={tr(locale, "重命名", "Rename")} disabled={modelLibraryBusy} onClick={() => void renameLibraryItem(asset, "asset")}><Pencil size={14} /></button>
            <button className="manager-icon-button danger" title={tr(locale, "删除图片", "Delete image")} disabled={modelLibraryBusy} onClick={() => void deleteLibraryAsset(asset)}><Trash2 size={15} /></button>
          </article>
        ))}
        {visibleVideos.map((asset) => (
          <article className="model-library-item asset-video-item" key={asset.id}>
            <div className="asset-video-preview"><Video size={21} /><span>{asset.fileName.split(".").at(-1)?.toUpperCase()}</span></div>
            <AssetInfo name={asset.name} size={asset.size} updatedAt={asset.updatedAt} locale={locale} hint={tr(locale, "可用于二维看板本地视频组件", "Ready for local dashboard video widgets")} />
            <div className="model-library-state"><span className="model-status model-status-ready">{tr(locale, "可使用", "Ready")}</span><ResourceUsageBadge locale={locale} resource={resourceGovernance.resources.find((resource) => resource.kind === "media" && resource.id === asset.id)} /></div>
            <button className="manager-icon-button" title={tr(locale, "重命名", "Rename")} disabled={modelLibraryBusy} onClick={() => void renameLibraryItem(asset, "asset")}><Pencil size={14} /></button>
            <button className="manager-icon-button danger" title={tr(locale, "删除视频", "Delete video")} disabled={modelLibraryBusy} onClick={() => void deleteLibraryAsset(asset)}><Trash2 size={15} /></button>
          </article>
        ))}
        {visibleAppearanceAssets.map((asset) => (
          <article className="model-library-item asset-image-item" key={asset.id}>
            <div className="asset-image-preview">{asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : asset.kind === "environment" ? <Mountain size={20} /> : <Paintbrush size={20} />}</div>
            <AssetInfo name={asset.name} size={asset.size} updatedAt={asset.updatedAt} locale={locale} hint={asset.kind === "environment" ? tr(locale, "可在场景环境中直接应用", "Apply from scene environment") : tr(locale, "可在选中模型的材质面板中应用", "Apply to the selected model from its material panel")} />
            <div className="model-library-state"><span className="model-status model-status-ready">{tr(locale, "可使用", "Ready")}</span></div>
            <button className="manager-icon-button" title={tr(locale, "重命名", "Rename")} disabled={modelLibraryBusy} onClick={() => void renameLibraryItem(asset, "asset")}><Pencil size={14} /></button>
            <button className="manager-icon-button danger" title={tr(locale, "删除资源", "Delete resource")} disabled={modelLibraryBusy} onClick={() => void deleteLibraryAsset(asset)}><Trash2 size={15} /></button>
          </article>
        ))}
        {visibleModels.length === 0 && visibleImages.length === 0 && visibleVideos.length === 0 && visibleAppearanceAssets.length === 0 && <div className="model-library-empty">{assetTab === "image" ? <ImageIcon size={34} /> : assetTab === "video" ? <Video size={34} /> : <Box size={34} />}<strong>{normalizedSearch ? tr(locale, "没有匹配的资源", "No matching assets") : tr(locale, "还没有项目素材", "No project assets yet")}</strong><span>{tr(locale, "可从公共素材导入，也可上传模型、图片或视频。", "Import from the library or upload models, images and videos.")}</span></div>}
      </div>
    </div>
  );
}

function AssetInfo({ name, size, updatedAt, locale, hint }: { name: string; size: number; updatedAt: string; locale: AppLocale; hint: string }) {
  return <div className="model-library-info"><strong title={name}>{name}</strong><span>{formatBytes(size)} · {new Date(updatedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span><small>{hint}</small></div>;
}

function assetTabLabel(tab: "all" | "model" | "image" | "video" | "environment" | "pbr-material", modelCount: number, assets: Array<{ kind: string }>, locale: AppLocale): string {
  if (tab === "all") return tr(locale, "全部", "All");
  if (tab === "model") return tr(locale, `模型 ${modelCount}`, `Models ${modelCount}`);
  const count = assets.filter((asset) => asset.kind === tab).length;
  if (tab === "image") return tr(locale, `图片 ${count}`, `Images ${count}`);
  if (tab === "video") return tr(locale, `视频 ${count}`, `Videos ${count}`);
  return tab === "environment" ? tr(locale, `环境 ${count}`, `Environments ${count}`) : tr(locale, `材质 ${count}`, `Materials ${count}`);
}

function statusLabel(status: ConversionStatus, locale: AppLocale): string {
  const labels: Record<ConversionStatus, [string, string]> = { queued: ["排队中", "Queued"], processing: ["处理中", "Processing"], ready: ["可使用", "Ready"], waiting_converter: ["待转换器", "Waiting converter"], failed: ["失败", "Failed"] };
  return tr(locale, labels[status][0], labels[status][1]);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
