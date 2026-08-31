import type { ProjectAssetRecord, SceneEnvironmentState, SceneMaterialState } from "@bim-studio/contracts";
import { Check, Mountain, Paintbrush } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";

interface SharedPickerProps {
  locale: AppLocale;
  assets: ProjectAssetRecord[];
  disabled?: boolean;
}

/** 项目材质资源只生成可序列化的场景补丁，保存与撤销仍走编辑器原有链路。 */
export function ProjectMaterialResourcePicker({ locale, assets, disabled, onApply, value }: SharedPickerProps & {
  value: SceneMaterialState;
  onApply: (patch: SceneMaterialState) => void;
}) {
  const materials = assets.filter((asset) => asset.kind === "pbr-material" && asset.maps?.length);
  if (!materials.length) return null;
  return (
    <details className="project-appearance-picker">
      <summary><span><Paintbrush size={13} />{tr(locale, "项目 PBR 材质", "Project PBR materials")}</span><small>{materials.length}</small></summary>
      <div className="project-appearance-grid">
        {materials.map((asset) => {
          const patch = materialPatchFromProjectAsset(asset);
          const active = Boolean(patch.baseColorMapUrl && patch.baseColorMapUrl === value.baseColorMapUrl);
          return (
            <button key={asset.id} disabled={disabled} className={active ? "active" : ""} title={`${asset.name} · ${asset.libraryOrigin?.license ?? ""}`} onClick={() => onApply(patch)}>
              <AssetThumbnail asset={asset} icon={<Paintbrush size={18} />} />
              <span>{asset.name}</span>
              {active && <Check size={12} />}
            </button>
          );
        })}
      </div>
    </details>
  );
}

export function ProjectEnvironmentResourcePicker({ locale, assets, disabled, value, onApply }: SharedPickerProps & {
  value: SceneEnvironmentState;
  onApply: (next: SceneEnvironmentState) => void;
}) {
  const environments = assets.filter((asset) => asset.kind === "environment" && asset.maps?.some((map) => map.kind === "environment"));
  if (!environments.length) return null;
  return (
    <details className="project-appearance-picker environment-resource-picker">
      <summary><span><Mountain size={13} />{tr(locale, "项目环境", "Project environments")}</span><small>{environments.length}</small></summary>
      <div className="project-appearance-grid">
        {environments.map((asset) => {
          const map = asset.maps!.find((item) => item.kind === "environment")!;
          const active = value.environmentMapUrl === map.url;
          return (
            <button key={asset.id} disabled={disabled} className={active ? "active" : ""} title={`${asset.name} · ${asset.libraryOrigin?.license ?? ""}`} onClick={() => onApply(environmentPatchFromProjectAsset(value, asset))}>
              <AssetThumbnail asset={asset} icon={<Mountain size={18} />} />
              <span>{asset.name}</span>
              {active && <Check size={12} />}
            </button>
          );
        })}
      </div>
    </details>
  );
}

export function materialPatchFromProjectAsset(asset: ProjectAssetRecord): SceneMaterialState {
  const map = (kind: NonNullable<ProjectAssetRecord["maps"]>[number]["kind"]) => asset.maps?.find((item) => item.kind === kind);
  const baseColor = map("base-color");
  const normal = map("normal");
  const ao = map("ao");
  const roughness = map("roughness");
  const metalness = map("metalness");
  return {
    ...(baseColor ? { baseColorMapUrl: baseColor.url, baseColorMapName: `${asset.name} · 基础色` } : {}),
    ...(normal ? { normalMapUrl: normal.url, normalMapName: `${asset.name} · 法线` } : {}),
    ...(ao ? { ambientOcclusionMapUrl: ao.url, ambientOcclusionMapName: `${asset.name} · 环境遮蔽` } : {}),
    ...(roughness ? { roughnessMapUrl: roughness.url, roughnessMapName: `${asset.name} · 粗糙度`, roughness: 1 } : {}),
    ...(metalness ? { metalnessMapUrl: metalness.url, metalnessMapName: `${asset.name} · 金属度`, metalness: 1 } : { metalness: 0 }),
  };
}

export function environmentPatchFromProjectAsset(value: SceneEnvironmentState, asset: ProjectAssetRecord): SceneEnvironmentState {
  const map = asset.maps?.find((item) => item.kind === "environment");
  return map ? { ...value, environmentMapUrl: map.url, environmentMapName: asset.name } : value;
}

function AssetThumbnail({ asset, icon }: { asset: ProjectAssetRecord; icon: React.ReactNode }) {
  return asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" /> : <i>{icon}</i>;
}
